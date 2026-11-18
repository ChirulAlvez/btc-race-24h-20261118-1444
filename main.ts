// Trough Recovery — a cbBTC dip-recovery bot for btc-race-24h-20261118-1444.
//
// What the dev window looks like: a slow 24h grind down (-2.79%) with one long
// recovery in the middle (+1.95% over bars ~240-540). Sharp dip-buying fails
// here (no V-shape: the biggest 60-minute forward move is only +1.19%), and
// trend-following churns itself to death (the EMA-cross baseline loses $148 on
// this window). So this bot buys only after a real selloff — the close at least
// 1.50% below the 240-bar high — once the price has bounced 0.30% off its
// 60-bar low, then rides the recovery with a +2.00% take-profit, a 0.70%
// trailing stop from the peak value, a 1.00% hard stop vs cost, and a 600-bar
// max hold. A loss halt stops new entries after $8.00 of cumulative realized
// loss, so a waterfall window cannot bleed the account through repeated failed
// recoveries (on the two prior races' dev windows this rule caps the worst
// window at -$11.63 instead of -$52.69, while leaving the good windows
// untouched).
//
// Dev-window result (grade-local, this window): +$17.25, 4 trades, max
// drawdown 1.44%; still +$15.63 at 2x fees. All baselines lose money here
// (buy-and-hold -$31.63, momentum -$23.87, RSI-Bollinger -$39.92).
//
// All arithmetic is integer (bigint) over the harness's own scales, so two
// runs on the same bars produce the same orders. No wall clock, no network,
// no randomness.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Rolling-low lookback, counting the current bar. */
const LOW_BARS = 60;
/** Entry needs the close this far above the rolling low, in bps. */
const REC_BPS = 30;
/** Drawdown lookback, counting the current bar. */
const HIGH_BARS = 240;
/** Entry needs the close this far below the lookback high, in bps. */
const DEEP_BPS = 150;
/** Take profit vs entry cost, in bps. */
const TP_BPS = 200;
/** Trailing stop vs peak value since entry, in bps. */
const TRAIL_BPS = 70;
/** Hard stop vs entry cost, in bps. */
const SL_BPS = 100;
/** Longest a position is held, in bars. */
const MAX_HOLD_BARS = 600;
/** Bars after a sell decision before the next entry. */
const COOLDOWN_BARS = 30;
/** Cumulative realized loss (quote units, $8.00) that halts new entries. */
const HALT_LOSS_QUOTE_UNITS = 8_000_000n;
/** Orders are capped 1% past the close they were decided on. */
const MAX_SLIPPAGE_BPS = 100;
/** The harness minimum buy, $1.00. */
const MIN_NOTIONAL = 1_000_000n;

/** Closes seen so far, oldest first, as raw price integers. */
const closes: bigint[] = [];
/** Seq of the bar whose open filled the current position's buy (-1: flat). */
let entrySeq = -1;
/** Quote units spent on the current position (the buy order's notional). */
let entryCost = 0n;
/** Highest value the current position has reached since entry. */
let peakValue = 0n;
/** Seq of the last sell decision (for the cooldown). */
let lastSellSeq = -1_000_000_000;
/** Realized loss accumulated over closed round trips, in quote units. */
let cumLoss = 0n;
/** True once the loss halt has tripped: no more entries this window. */
let halted = false;

/** Lowest close over the last `n` closes (the current bar included). */
function rollingLow(n: number): bigint {
  let low = closes[closes.length - 1]!;
  for (let k = closes.length - 2; k >= closes.length - n; k--) {
    if (closes[k]! < low) low = closes[k]!;
  }
  return low;
}

/** Highest close over the last `n` closes (the current bar included). */
function rollingHigh(n: number): bigint {
  let high = closes[closes.length - 1]!;
  const start = Math.max(0, closes.length - n);
  for (let k = closes.length - 2; k >= start; k--) {
    if (closes[k]! > high) high = closes[k]!;
  }
  return high;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // Fold in this batch's fills: orders decided on the previous bar filled at
    // this bar's open. A filled buy opens the position (its notional is the
    // cost basis); a filled sell closes it.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.symbol !== SYMBOL) continue;
      if (fill.side === 'buy') {
        entrySeq = batch.seq;
        entryCost = BigInt(fill.notional_quote_units);
        const held = state.positions.get(SYMBOL);
        peakValue = held !== undefined ? state.value(SYMBOL, held.qty) : 0n;
      } else {
        entrySeq = -1;
        entryCost = 0n;
        peakValue = 0n;
      }
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined || state.warmingUp) return [];
    closes.push(BigInt(bar.c));
    const close = BigInt(bar.c);

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      // A held position always blocks new entries, even if the entry cost was
      // somehow lost (a missed fill): buying into an open position would only
      // be rejected by the replay's one-position cap.
      if (entryCost <= 0n) return [];
      const value = state.value(SYMBOL, held.qty);
      if (value > peakValue) peakValue = value;
      const takeProfit = value * 10_000n >= entryCost * BigInt(10_000 + TP_BPS);
      const trailing = peakValue > 0n && value * 10_000n <= peakValue * BigInt(10_000 - TRAIL_BPS);
      const stopLoss = value * 10_000n <= entryCost * BigInt(10_000 - SL_BPS);
      const tooLong = entrySeq >= 0 && batch.seq - entrySeq >= MAX_HOLD_BARS;
      if (takeProfit || trailing || stopLoss || tooLong) {
        if (value < entryCost) {
          cumLoss += entryCost - value;
          if (cumLoss >= HALT_LOSS_QUOTE_UNITS) halted = true;
        }
        lastSellSeq = batch.seq;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    if (halted) return [];
    if (closes.length <= LOW_BARS) return [];
    if (batch.seq < lastSellSeq + COOLDOWN_BARS) return [];
    if (state.cash < MIN_NOTIONAL) return [];
    const low = rollingLow(LOW_BARS + 1);
    const high = rollingHigh(HIGH_BARS + 1);
    const recovered = close * 10_000n >= low * BigInt(10_000 + REC_BPS);
    const deep = close * 10_000n <= high * BigInt(10_000 - DEEP_BPS);
    if (!recovered || !deep) return [];
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
