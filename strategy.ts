// Whale Follow for the pump.fun replay (agent-fun/replay/v2).
//
// Idea: on this window the coins that complete are almost all driven by one
// huge buy at launch — a single buy of 10+ SOL — and after it the survivors
// run several multiples, while coins with no such buy almost never complete
// and mostly dump 30-50%. The catch is that most completions happen inside
// a single slot, so they are already complete before any bot can act; the
// catchable ones are the few slow grinders that take hundreds of slots to
// finish. So the bot takes many small shots: it buys a small fixed stake
// right after a whale buy of 10+ SOL on a curve that is still early in its
// climb (5-25 SOL of real reserves), cuts every loser fast on a tight
// stop-loss, and lets the rare runner ride under a trailing stop with no
// fixed take-profit. Small stakes keep the losers cheap; the handful of
// runners pay for them. Pyramiding into climbers was tried and rejected:
// it scales into coins mid-pump that then crash, so adds are capped off in
// the defaults (maxTotalSol equals the stake).
//
// Every decision is deterministic: no clock, no randomness, no network, no
// environment reads. Iteration follows the batch stream's insertion order and
// the insertion order of the maps fed by it.
//
// Fees shape every number here. A round trip pays ~1.25% of size in curve
// fees each way plus 105,000 lamports of tx fees per order, so a 0.02 SOL
// stake costs ~0.0007 SOL (~3.6%) to round-trip. The stop-loss (-8%) is set
// wide of that cost, and buys smaller than 0.012 SOL are skipped because
// the tx fees alone would eat the trade.
//
// The harness calls onBatch once per slot batch with the slot's events; the
// bot answers with its orders for that slot (they fill two slots later).
// onHello runs once before the first batch; onDone runs once at the end.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** SOL put into one position (before the 1%-of-real-reserve cap). */
  stakeSol: number;
  /** Smallest buy worth sending: below this the tx fees eat the trade. */
  minBuySol: number;
  /** Trades kept per curve tape. */
  tapeLen: number;
  /** Trades at the tail of the tape the entry signal reads. */
  windowTrades: number;
  /** Minimum trades on a curve before it can be bought. */
  minTrades: number;
  /** A single buy of at least this many SOL counts as a whale buy. */
  whaleSol: number;
  /** The whale buy must be within this many recent trades. */
  whaleWindowTrades: number;
  /** Price now must be at least this share of the window high. */
  nearHigh: number;
  /** A single sell of at least this many SOL in the window vetoes the entry. */
  maxSingleSellSol: number;
  /** Skip the curve when its creator has sold any amount before entry. */
  skipCreatorSold: boolean;
  /** Real SOL reserves a curve must have at entry (still early in its climb). */
  minRealSol: number;
  maxRealSol: number;
  /** Stop-loss against cost, as a fraction. */
  stopLoss: number;
  /** Trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Sell once value falls this far below its peak after arming. */
  trailGiveback: number;
  /** Most SOL to build into one coin in total, first buy plus adds. */
  maxTotalSol: number;
  /** SOL per add while the curve keeps climbing. */
  addSol: number;
  /** Real SOL must have grown by at least this factor since the last buy to add. */
  addRqGrowth: number;
  /** Price now over the last buy's decision price: adds only into strength. */
  addMinPriceUp: number;
  /** Most adds per coin. */
  maxAdds: number;
  /** Slots a position may be held while it is not clearly winning. */
  maxHoldSlots: number;
  /** Winning means at least this far above cost when the time stop is checked. */
  holdWinUp: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldownSlots: number;
  /** Most entries per curve over the whole run (spread across coins). */
  maxEntriesPerMint: number;
  /** Most positions open at once (the cap is five). */
  maxPositions: number;
  /** Keep this much cash unspent so a late exit never strands the bot. */
  cashBufferSol: number;
  /** Slippage allowed on buys; sells always go out wide so exits land. */
  buySlippageBps: number;
  sellSlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeSol: 0.02,
  minBuySol: 0.012,
  tapeLen: 80,
  windowTrades: 10,
  minTrades: 3,
  whaleSol: 10,
  whaleWindowTrades: 10,
  nearHigh: 0.9,
  maxSingleSellSol: 2.0,
  skipCreatorSold: true,
  minRealSol: 5,
  maxRealSol: 25,
  stopLoss: 0.08,
  trailArm: 0.5,
  trailGiveback: 0.25,
  // Adds are implemented but capped off: maxTotalSol equals the stake, so no
  // add ever fires. Sweeps showed pyramiding into climbers loses money here
  // (it scales into coins mid-pump that then crash); the code stays so the
  // choice is explicit and reversible.
  maxTotalSol: 0.02,
  addSol: 0.06,
  addRqGrowth: 1.4,
  addMinPriceUp: 1.0,
  maxAdds: 6,
  maxHoldSlots: 10000,
  holdWinUp: 0.05,
  cooldownSlots: 300,
  maxEntriesPerMint: 1,
  maxPositions: 5,
  cashBufferSol: 0.5,
  buySlippageBps: 500,
  sellSlippageBps: 10_000,
};

const LAMPORTS = 1e9;

// ---------------------------------------------------------------------------
// Per-curve tape: the recent trades, in arrival order.
// ---------------------------------------------------------------------------

interface TapeTrade {
  slot: number;
  /** SOL per token at the trade (virtual reserves ratio). */
  price: number;
  /** SOL moved by the trade. */
  sol: number;
  buy: boolean;
  /** Wallet that made the trade. */
  user: string;
  /** Real SOL reserves after the trade. */
  realSol: number;
}

interface Tape {
  trades: TapeTrade[];
  createdSlot: number | null;
  creator: string | null;
  creatorSold: boolean;
  complete: boolean;
}

interface Held {
  buySlot: number;
  /** Best mark value seen since the buy, in lamports. */
  peakLamports: bigint;
}

interface BuyBook {
  /** SOL spent on buys decided so far (fills usually land; overstates only). */
  investedLamports: bigint;
  /** Real SOL at the last buy decision. */
  lastRq: number;
  /** Price at the last buy decision. */
  lastPrice: number;
  /** Adds decided so far. */
  adds: number;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

// ---------------------------------------------------------------------------
// Strategy.
// ---------------------------------------------------------------------------

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const buyBook = new Map<Pubkey, BuyBook>();
  const lastExitSlot = new Map<Pubkey, number>();
  const entriesUsed = new Map<Pubkey, number>();

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { trades: [], createdSlot: null, creator: null, creatorSold: false, complete: false };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Mark value of a position now, in lamports, or null when unpriced. */
  const markValue = (state: BotState, mint: Pubkey, tokens: bigint): bigint | null => {
    const curve = state.curves.get(mint);
    if (curve === undefined) return null;
    const pr = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (!(pr > 0)) return null;
    return BigInt(Math.floor(Number(tokens) * pr));
  };

  const onBatch = (state: BotState, batch: Batch): OrderInput[] => {
    const now = batch.slot;
    const orders: OrderInput[] = [];
    const traded = new Set<Pubkey>();

    // Fold this slot's events into the tapes.
    for (const e of batch.events) {
      traded.add(e.mint);
      const t = tapeOf(e.mint);
      if (e.event === 'CreateEvent') {
        t.createdSlot = e.slot;
        t.creator = e.creator;
      } else if (e.event === 'TradeEvent') {
        t.trades.push({
          slot: e.slot,
          price: priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)),
          sol: Number(e.sol_amount) / LAMPORTS,
          buy: e.is_buy,
          user: e.user,
          realSol: Number(e.real_sol_reserves) / LAMPORTS,
        });
        if (t.trades.length > p.tapeLen) t.trades.splice(0, t.trades.length - p.tapeLen);
        if (!e.is_buy && t.creator !== null && e.user === t.creator) t.creatorSold = true;
      } else {
        t.complete = true;
      }
    }

    // Mints with a buy still in flight: do not double-enter before it lands.
    const pendingBuys = new Set<Pubkey>();
    for (const pd of state.pending.values()) {
      if (pd.order.side === 'buy') pendingBuys.add(pd.order.mint);
    }

    // --- Exits: every held position is re-priced from its curve's marks. ---
    for (const [mint, pos] of state.positions) {
      const value = markValue(state, mint, pos.token_amount);
      if (value === null) continue;
      const h = held.get(mint);
      if (h === undefined) {
        held.set(mint, { buySlot: now, peakLamports: value });
        continue;
      }
      if (value > h.peakLamports) h.peakLamports = value;
      const cost = pos.cost_lamports;
      const up = Number(value - cost) / Number(cost);
      const offPeak = Number(h.peakLamports - value) / Number(h.peakLamports);
      const age = now - h.buySlot;
      let exit = false;
      if (up <= -p.stopLoss) exit = true; // cut the loser
      else if (up >= p.trailArm && offPeak >= p.trailGiveback) exit = true; // trail the runner
      else if (age >= p.maxHoldSlots && up <= p.holdWinUp) exit = true; // stale, not winning
      if (exit) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlippageBps });
        held.delete(mint);
        lastExitSlot.set(mint, now);
      }
    }

    // --- Entries: only curves that traded in this batch. ---
    if (state.committedPositionCount() < p.maxPositions || state.positions.size > 0) {
      const stakeLamports = BigInt(Math.round(p.stakeSol * LAMPORTS));
      const minBuyLamports = BigInt(Math.round(p.minBuySol * LAMPORTS));
      const maxTotalLamports = BigInt(Math.round(p.maxTotalSol * LAMPORTS));
      const addLamports = BigInt(Math.round(p.addSol * LAMPORTS));
      let freeCash = state.freeCashLamports() - BigInt(Math.round(p.cashBufferSol * LAMPORTS));
      for (const mint of traded) {
        if (orders.length >= 16) break;
        const t = tapes.get(mint);
        if (t === undefined || t.complete) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const lastTrade = t.trades[t.trades.length - 1];

        // --- Adds: a held coin that keeps climbing gets more size. ---
        if (state.positions.has(mint) && !pendingBuys.has(mint) && lastTrade !== undefined) {
          const book = buyBook.get(mint);
          if (
            book !== undefined &&
            book.adds < p.maxAdds &&
            book.investedLamports < maxTotalLamports &&
            realSol >= p.addRqGrowth * book.lastRq &&
            lastTrade.price >= p.addMinPriceUp * book.lastPrice
          ) {
            let size = addLamports;
            const remaining = maxTotalLamports - book.investedLamports;
            if (size > remaining) size = remaining;
            const cap = state.maxBuyLamports(mint);
            if (size > cap) size = cap;
            if (size > freeCash) size = freeCash;
            if (size >= minBuyLamports) {
              orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: p.buySlippageBps });
              freeCash -= size + state.txFeeLamports();
              book.investedLamports += size;
              book.lastRq = realSol;
              book.lastPrice = lastTrade.price;
              book.adds += 1;
              continue;
            }
          }
        }
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= p.maxPositions) continue;
        if (freeCash < minBuyLamports) break;
        if (t.trades.length < p.minTrades) continue;
        if (state.positions.has(mint)) continue;
        if (pendingBuys.has(mint)) continue;
        const used = entriesUsed.get(mint) ?? 0;
        if (used >= p.maxEntriesPerMint) continue;
        const lastExit = lastExitSlot.get(mint);
        if (lastExit !== undefined && now - lastExit < p.cooldownSlots) continue;
        if (p.skipCreatorSold && t.creatorSold) continue;

        if (realSol < p.minRealSol || realSol > p.maxRealSol) continue;

        // A whale buy must have landed within the recent trades.
        const tail = t.trades.slice(-p.whaleWindowTrades);
        let whale = false;
        for (const tr of tail) {
          if (tr.buy && tr.sol >= p.whaleSol) {
            whale = true;
            break;
          }
        }
        if (!whale) continue;

        const window = t.trades.slice(-p.windowTrades);
        const last = window[window.length - 1]!;
        if (!last.buy) continue; // the latest print must itself be a buy
        let high = 0;
        for (const tr of window) if (tr.price > high) high = tr.price;
        if (!(high > 0)) continue;
        if (last.price < p.nearHigh * high) continue; // must sit near its high
        let bigSell = false;
        for (const tr of tail) {
          if (!tr.buy && tr.sol >= p.maxSingleSellSol) {
            bigSell = true;
            break;
          }
        }
        if (bigSell) continue; // no big dump hanging over the entry

        // Size: the fixed stake, capped by 1% of real reserves and by cash.
        let size = stakeLamports;
        const cap = state.maxBuyLamports(mint);
        if (size > cap) size = cap;
        if (size > freeCash) size = freeCash;
        if (size < minBuyLamports) continue;

        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: p.buySlippageBps });
        freeCash -= size + state.txFeeLamports();
        entriesUsed.set(mint, used + 1);
        buyBook.set(mint, { investedLamports: size, lastRq: realSol, lastPrice: lastTrade.price, adds: 0 });
      }
    }

    return orders;
  };

  return {
    onBatch,
    onDone: () => {
      // Nothing to do: the harness flattens open positions itself.
    },
  };
}
