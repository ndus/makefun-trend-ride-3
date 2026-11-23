import { BPS, runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const EMA_FAST = 5;
const EMA_SLOW = 250;
const MOM_BARS = 200;
const TRAIL_STOP = 0.04;
const EXIT_MOM = -0.01;
const COOLDOWN_BARS = 600;
const STAKE_BPS = 9800n;
const MAX_SLIPPAGE_BPS = 100;

type SymbolState = {
  closes: number[];
  fastSeed: number[];
  fast: number | null;
  slow: number | null;
  seen: number;
  peak: number | null;
  cooldown: number;
};

let symbolStates = new Map<string, SymbolState>();

await runBars({
  onHello(state: BarsState) {
    symbolStates = new Map();
    for (const { symbol } of state.hello.symbols) {
      symbolStates.set(symbol, {
        closes: [],
        fastSeed: [],
        fast: null,
        slow: null,
        seen: 0,
        peak: null,
        cooldown: 0,
      });
    }
  },
  onBatch(state: BarsState, batch) {
    const sells: OrderInput[] = [];
    const candidates: string[] = [];

    for (const { symbol } of state.hello.symbols) {
      const closeRaw = state.close(symbol);
      if (closeRaw === null) continue;

      const data = symbolStates.get(symbol)!;
      const close = Number(closeRaw);
      data.seen++;

      if (data.fast !== null) {
        data.fast += (2 / (EMA_FAST + 1)) * (close - data.fast);
      } else {
        data.fastSeed.push(close);
        if (data.fastSeed.length === EMA_FAST) {
          data.fast = data.fastSeed.reduce((sum, value) => sum + value, 0) / EMA_FAST;
        }
      }

      data.closes.push(close);
      if (data.closes.length > MOM_BARS + 1) data.closes.shift();

      if (data.slow !== null) {
        data.slow += (2 / (EMA_SLOW + 1)) * (close - data.slow);
      } else if (data.seen === EMA_SLOW) {
        data.slow = data.closes.reduce((sum, value) => sum + value, 0) / EMA_SLOW;
      }

      const position = state.positions.get(symbol);
      if (position !== undefined) {
        data.cooldown = 0;
        data.peak = data.peak === null ? close : Math.max(data.peak, close);
        const momentum = data.closes.length === MOM_BARS + 1
          ? close / data.closes[0]! - 1
          : null;
        const shouldExit =
          (data.fast !== null && data.slow !== null && data.fast < data.slow) ||
          close <= data.peak * (1 - TRAIL_STOP) ||
          (momentum !== null && momentum < EXIT_MOM);

        if (shouldExit) {
          sells.push({ side: 'sell', symbol, qty: position.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          data.peak = null;
          data.cooldown = COOLDOWN_BARS;
        }
      } else {
        data.peak = null;
        if (data.cooldown > 0) {
          data.cooldown--;
          continue;
        }

        const momentumClose = data.closes.length === MOM_BARS + 1 ? data.closes[0]! : null;
        if (
          data.fast !== null &&
          data.slow !== null &&
          data.seen >= EMA_SLOW &&
          momentumClose !== null &&
          data.fast > data.slow &&
          close > momentumClose
        ) {
          candidates.push(symbol);
        }
      }
    }

    if (batch.seq < state.warmupBars) return [];
    if (sells.length > 0) return sells.slice(0, state.hello.caps.max_orders_per_bar);

    const slots = Math.min(state.hello.symbols.length, state.hello.caps.max_open_positions);
    const room = Math.max(0, slots - state.positions.size);
    const buyCount = Math.min(room, state.hello.caps.max_orders_per_bar, candidates.length);
    if (buyCount === 0) return [];

    const perSlot = state.equity / BigInt(slots);
    const weightCap = (BigInt(state.hello.caps.max_weight_bps) * state.equity) / BPS;
    const availableCash = state.cash / BigInt(buyCount);
    const base = perSlot < weightCap
      ? (perSlot < availableCash ? perSlot : availableCash)
      : (weightCap < availableCash ? weightCap : availableCash);
    const stake = (base * STAKE_BPS) / BPS;
    if (stake < BigInt(state.hello.fees.min_notional_quote_units) || stake <= 0n) return [];

    return candidates.slice(0, buyCount).map((symbol) => ({
      side: 'buy',
      symbol,
      notional_quote_units: stake,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    }));
  },
});
