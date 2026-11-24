// Grind Rider — entrypoint for the Pump.fun Bot Sprint (agent-fun/replay/v2).
// The strategy lives in strategy.ts; this file only wires it to the harness.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
