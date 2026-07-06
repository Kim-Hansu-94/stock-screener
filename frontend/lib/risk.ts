export type PriceBar = { date: string; high: number; low: number; close: number }

// Bounds a bar series to a point in time, so callers computing risk for a past
// entry never leak in bars from after that date (which would mix the entry's
// own subsequent price action into its own risk figure).
export function filterBarsAsOf(bars: PriceBar[], asOfDate: string): PriceBar[] {
  return bars.filter((bar) => bar.date <= asOfDate)
}

export function computeATR(bars: PriceBar[], period = 14): number {
  if (bars.length < 2) return 0
  const trs: number[] = []
  for (let i = 1; i < bars.length; i++) {
    trs.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    ))
  }
  const slice = trs.slice(-period)
  return slice.length > 0 ? slice.reduce((a, b) => a + b, 0) / slice.length : 0
}

// Matches pipeline/src/screener.py's long_term_up gate exactly (LONG_TERM_WINDOW=60,
// SHORT_TERM_WINDOW=5) so a stock's risk display never claims "uptrend" under a looser
// or stricter test than the one that actually admitted it into the screener.
const TREND_SMA_PERIOD = 60
const TREND_LOOKBACK = 5

function computeSMA(bars: PriceBar[], period: number): number | null {
  if (bars.length < period) return null
  const slice = bars.slice(-period)
  return slice.reduce((sum, b) => sum + b.close, 0) / period
}

// Requires price above a rising SMA60 so a downtrending stock's tight ATR stop
// doesn't produce a misleadingly high risk-reward ratio (RR ignores trend direction otherwise)
export function isUptrend(bars: PriceBar[]): boolean {
  if (bars.length < TREND_SMA_PERIOD + TREND_LOOKBACK) return false
  const smaNow = computeSMA(bars, TREND_SMA_PERIOD)
  const smaPrior = computeSMA(bars.slice(0, -TREND_LOOKBACK), TREND_SMA_PERIOD)
  if (smaNow === null || smaPrior === null) return false
  const latestClose = bars.at(-1)!.close
  return latestClose > smaNow && smaNow > smaPrior
}

// Plain "still above its 60-day average" check, for re-evaluating a position already
// taken — deliberately looser than isUptrend's rising-SMA entry gate, since a held
// position should only be flagged once the trend it was bought on actually breaks,
// not merely because the SMA stopped climbing.
export function isBelowTrend(bars: PriceBar[]): boolean {
  const sma = computeSMA(bars, TREND_SMA_PERIOD)
  if (sma === null) return false
  return bars.at(-1)!.close < sma
}

// Resistance search window: wide enough to catch prior swing highs that a 30-bar
// window would miss, so the target isn't silently replaced by the arbitrary 2R fallback.
const RESISTANCE_LOOKBACK = 90
// Bars required on each side to confirm a local high as a genuine pivot (not just noise).
const PIVOT_WINDOW = 3
// A pivot only counts as real resistance if price pulled back at least this much (as a
// fraction of the peak) on BOTH sides — filters out shallow multi-bar wiggles that
// technically qualify as a local max but were never actually defended as resistance,
// which were producing unrealistically close targets (and unrealistically low RR).
const PIVOT_MIN_PROMINENCE = 0.03

// Local pivot highs: a bar whose high is the max within PIVOT_WINDOW bars on each side,
// AND whose surrounding lows retrace at least PIVOT_MIN_PROMINENCE below it on both sides.
// Sorted ascending so callers can pick the nearest genuinely significant one above entry.
function findPivotHighs(
  bars: PriceBar[],
  window = PIVOT_WINDOW,
  minProminence = PIVOT_MIN_PROMINENCE,
): number[] {
  const pivots: number[] = []
  for (let i = window; i < bars.length - window; i++) {
    const h = bars[i].high
    const isLocalMax = bars.slice(i - window, i + window + 1).every((b) => b.high <= h)
    if (!isLocalMax) continue

    const leftLow = Math.min(...bars.slice(i - window, i).map((b) => b.low))
    const rightLow = Math.min(...bars.slice(i + 1, i + window + 1).map((b) => b.low))
    const prominence = Math.min(h - leftLow, h - rightLow) / h
    if (prominence >= minProminence) pivots.push(h)
  }
  return pivots.sort((a, b) => a - b)
}

// Breathing room under the swing low, in ATRs. Half an average day's range is enough
// to survive a stop-hunt wick without meaningfully widening per-share risk.
const STOP_BUFFER_ATR_MULT = 0.5

export function computeStopTarget(
  bars: PriceBar[],
  entry: number,
): { stop: number | null; target: number | null; riskReward: number | null } {
  if (bars.length < 10 || !isUptrend(bars)) {
    return { stop: null, target: null, riskReward: null }
  }

  const recent20 = bars.slice(-20)
  const swingLow = Math.min(...recent20.map((p) => p.low))
  const atr = computeATR(recent20)
  const atrStop = atr > 0 ? entry - 1.5 * atr : swingLow
  // Buffer the structural stop below the swing low: a stop placed exactly at an
  // obvious low gets picked off by intraday probes that touch the level and reverse.
  const swingStop = swingLow - STOP_BUFFER_ATR_MULT * atr
  // Take the tighter (higher) of the two stops
  const rawStop = Math.max(swingStop, atrStop)

  if (rawStop >= entry) return { stop: null, target: null, riskReward: null }
  const stop = rawStop
  const risk = entry - stop

  // Target: nearest confirmed pivot high above entry (nearest resistance) →
  // absolute high over the extended lookback if above entry → fixed 2R as last resort
  // (only hit when the stock is breaking out to new highs with no resistance overhead).
  const extended = bars.slice(-RESISTANCE_LOOKBACK)
  const pivotsAboveEntry = findPivotHighs(extended).filter((h) => h > entry)
  const periodHigh = Math.max(...extended.map((p) => p.high))

  let target: number
  if (pivotsAboveEntry.length > 0) {
    target = pivotsAboveEntry[0]
  } else if (periodHigh > entry) {
    target = periodHigh
  } else {
    target = entry + 2 * risk
  }

  return { stop, target, riskReward: (target - entry) / risk }
}
