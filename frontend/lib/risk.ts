export type PriceBar = { date: string; high: number; low: number; close: number }

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

const TREND_SMA_PERIOD = 20
const TREND_LOOKBACK = 5

function computeSMA(bars: PriceBar[], period: number): number | null {
  if (bars.length < period) return null
  const slice = bars.slice(-period)
  return slice.reduce((sum, b) => sum + b.close, 0) / period
}

// Requires price above a rising SMA20 so a downtrending stock's tight ATR stop
// doesn't produce a misleadingly high risk-reward ratio (RR ignores trend direction otherwise)
export function isUptrend(bars: PriceBar[]): boolean {
  if (bars.length < TREND_SMA_PERIOD + TREND_LOOKBACK) return false
  const smaNow = computeSMA(bars, TREND_SMA_PERIOD)
  const smaPrior = computeSMA(bars.slice(0, -TREND_LOOKBACK), TREND_SMA_PERIOD)
  if (smaNow === null || smaPrior === null) return false
  const latestClose = bars.at(-1)!.close
  return latestClose > smaNow && smaNow > smaPrior
}

// Resistance search window: wide enough to catch prior swing highs that a 30-bar
// window would miss, so the target isn't silently replaced by the arbitrary 2R fallback.
const RESISTANCE_LOOKBACK = 90
// Bars required on each side to confirm a local high as a genuine pivot (not just noise).
const PIVOT_WINDOW = 3

// Local pivot highs: a bar whose high is the max within PIVOT_WINDOW bars on each side.
// Sorted ascending so callers can pick the nearest one above entry.
function findPivotHighs(bars: PriceBar[], window = PIVOT_WINDOW): number[] {
  const pivots: number[] = []
  for (let i = window; i < bars.length - window; i++) {
    const h = bars[i].high
    const isPivot = bars.slice(i - window, i + window + 1).every((b) => b.high <= h)
    if (isPivot) pivots.push(h)
  }
  return pivots.sort((a, b) => a - b)
}

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
  // Take the tighter (higher) of the two stops
  const rawStop = Math.max(swingLow, atrStop)

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
