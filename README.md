# Whale Follow — Pump.fun Bot Sprint

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/giandisruw/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/giandisruw/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) bounty on make.fun. It trades 10 SOL of paper money on a 6-hour replay of pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy

On the dev window the coins that complete are almost all driven by one huge buy at launch — a single buy of 10+ SOL — and the survivors then run several multiples, while coins with no such buy almost never complete and mostly dump 30–50%. Most completions happen inside a single slot, so they are already complete before any bot can act; the catchable ones are the few slow grinders that take hundreds of slots to finish. So this bot takes many small shots:

- **Entry — follow the whale.** A curve becomes a buy when a single buy of 10+ SOL landed within its last 10 trades, its real SOL reserves sit between 5 and 25 SOL (still early in the climb), its latest print is a buy sitting near its recent high, no single sell of 2+ SOL hangs over it, and its creator has not sold.
- **Size.** A fixed 0.02 SOL stake per position, capped by the harness limit of 1% of the curve's real SOL reserves and by free cash. Buys under 0.012 SOL are skipped — the flat tx fees would eat them.
- **Exits — cut losers fast, let runners ride.** Sell the whole position on the first of: −8% stop-loss, a 25% trailing giveback once +50% is reached, or a 10,000-slot time stop while the position is not clearly winning. There is no fixed take-profit.
- **Discipline.** At most 5 open positions, one entry per curve per run, and a 300-slot cooldown after an exit. Pyramiding into climbers was tried and rejected in testing: it scales into coins mid-pump that then crash, so adds are capped off in the defaults (see `strategy.ts`).

Everything is deterministic: no clock, no randomness, no network calls, no API keys, no environment reads. The bot is `main.ts` + `strategy.ts` (Node 22, TypeScript run as-is) on top of the kit's `vendor/makefun-bot.ts` shim.

## Dev-window result (honest numbers)

Graded locally with the bounty kit on its frozen dev window (`grade-local --driver process`):

- **Net PnL: −0.111 SOL** (27 round trips, 27 coins, max drawdown 1.17%, win rate 7.4%)
- Meets the minimum bar: 27 coins with ≥0.01 SOL round trips (bar: 20), drawdown 1.17% (bar: ≤50%)
- The dev window is a hard, mostly-losing sample for trend strategies — the sibling dip-bounce entry scored −0.140 SOL on the same data. The final 6-hour window is a fresh draw; this entry's edge is its small, controlled losses and its open upside on the rare slow completer.

## Run it

Grade locally with the bounty kit (from inside the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

## Files

- `main.ts` — the entrypoint: wires the strategy to the harness.
- `strategy.ts` — the whole strategy (Whale Follow) with its tunables.
- `vendor/makefun-bot.ts` — the kit's bot shim, vendored byte for byte.
- `LICENSE` — MIT.
- `.makefun/owner.json` — the claim file naming the payout wallet.

## License

MIT — see [LICENSE](LICENSE).

---
Built with make.fun — referral code `0txwmf1m`.
