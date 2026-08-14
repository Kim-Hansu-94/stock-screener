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

// Why computeStopTarget declined to produce a risk-reward figure. Surfaced to the UI
// so a blank "—" reads as an explained state rather than an error.
export type RiskReason =
  | 'ok'
  | 'insufficient_data' // fewer bars than the trend/range windows need
  | 'stop_above_entry' // structural stop landed at or above entry (no measurable risk)
  | 'no_upside' // 박스 상단에 이미 닿아 있어 위쪽 여유가 없음

// 어떤 틀로 계산했는지. 추세 종목과 횡보 종목은 손절·목표를 잡는 근거가 달라
// 같은 공식을 쓰면 한쪽이 왜곡된다. 화면에서도 이 둘을 구분해 보여준다.
export type RiskFrame = 'trend' | 'range'

type TrendStatus = 'uptrend' | 'insufficient_data' | 'below_sma60' | 'sma60_falling'

export interface RiskResult {
  stop: number | null
  target: number | null
  riskReward: number | null
  reason: RiskReason
  frame: RiskFrame | null
  /** 진입가와 목표가 사이에 걸린 첫 저항 — 한 번 막힐 수 있는 지점 */
  wayResistance: number | null
}

// Granular version of the uptrend gate: same thresholds as isUptrend, but reports WHICH
// condition failed so callers can explain a declined risk-reward instead of just nulling it.
export function trendStatus(bars: PriceBar[]): TrendStatus {
  if (bars.length < TREND_SMA_PERIOD + TREND_LOOKBACK) return 'insufficient_data'
  const smaNow = computeSMA(bars, TREND_SMA_PERIOD)
  const smaPrior = computeSMA(bars.slice(0, -TREND_LOOKBACK), TREND_SMA_PERIOD)
  if (smaNow === null || smaPrior === null) return 'insufficient_data'
  const latestClose = bars.at(-1)!.close
  if (latestClose <= smaNow) return 'below_sma60'
  if (smaNow <= smaPrior) return 'sma60_falling'
  return 'uptrend'
}

// Requires price above a rising SMA60 so a downtrending stock's tight ATR stop
// doesn't produce a misleadingly high risk-reward ratio (RR ignores trend direction otherwise)
export function isUptrend(bars: PriceBar[]): boolean {
  return trendStatus(bars) === 'uptrend'
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

// 임팩트(선행 상승) 구간을 찾는 창. screener.py의 IMPULSE_LOOKBACK_DAYS와 같다.
const IMPULSE_LOOKBACK = 60
// 횡보 종목의 박스 상단을 재는 창.
const RANGE_WINDOW = 60

const NO_RISK = { stop: null, target: null, riskReward: null, wayResistance: null } as const

/**
 * 임팩트 투영(measured move) 목표가.
 *
 * 이 스크리너는 "60일 +15% 급등 뒤 얕게 눌린" 자리를 산다. 즉 추세가 다시 이어져
 * 신고가를 낼 것에 베팅하는데, 목표를 "진입가 위 가장 가까운 저항"으로 잡으면
 * 방금 눌리기 전 그 고점이 목표가 되어 보상이 1~3%밖에 안 나온다. 손절은
 * 1.5 ATR이라 손익비가 0.2~0.3까지 떨어졌고, 눌림이 얕을수록(= 강한 종목일수록)
 * 더 나빠지는 역설이 있었다.
 *
 * 대신 직전 상승폭을 눌림 저점에서 다시 투영한다 — 전략의 전제와 같은 가정이다.
 */
function measuredMoveTarget(bars: PriceBar[], entry: number): number | null {
  if (bars.length < IMPULSE_LOOKBACK) return null
  const window = bars.slice(-IMPULSE_LOOKBACK)

  let highIdx = 0
  for (let i = 1; i < window.length; i++) {
    if (window[i].high > window[highIdx].high) highIdx = i
  }
  const impulseHigh = window[highIdx].high
  const impulseLow = Math.min(...window.slice(0, highIdx + 1).map((b) => b.low))
  const pullbackLow = Math.min(...window.slice(highIdx).map((b) => b.low))

  const height = impulseHigh - impulseLow
  if (height <= 0) return null
  const target = pullbackLow + height
  return target > entry ? target : null
}

/** 상승 추세 종목: 구조적 손절 + 임팩트 투영 목표 */
function trendFrame(bars: PriceBar[], entry: number): RiskResult {
  const recent20 = bars.slice(-20)
  const swingLow = Math.min(...recent20.map((p) => p.low))
  const atr = computeATR(recent20)
  const atrStop = atr > 0 ? entry - 1.5 * atr : swingLow
  // Buffer the structural stop below the swing low: a stop placed exactly at an
  // obvious low gets picked off by intraday probes that touch the level and reverse.
  const swingStop = swingLow - STOP_BUFFER_ATR_MULT * atr
  // Take the tighter (higher) of the two stops
  const rawStop = Math.max(swingStop, atrStop)

  if (rawStop >= entry) return { ...NO_RISK, reason: 'stop_above_entry', frame: 'trend' }
  const stop = rawStop
  const risk = entry - stop

  const extended = bars.slice(-RESISTANCE_LOOKBACK)
  const periodHigh = Math.max(...extended.map((p) => p.high))
  const measured = measuredMoveTarget(bars, entry)

  // 투영이 불가능한 경우에만 기존 방식으로 물러선다: 기간 최고가 → 고정 2R
  let target: number
  if (measured !== null) target = measured
  else if (periodHigh > entry) target = periodHigh
  else target = entry + 2 * risk

  // 경유 저항: 목표까지 가는 길에 걸린 첫 저항. 목표를 대체하지는 않고,
  // "여기서 한 번 막힐 수 있다"를 알리는 용도로만 쓴다.
  const onTheWay = findPivotHighs(extended).filter((h) => h > entry && h < target)

  return {
    stop,
    target,
    riskReward: (target - entry) / risk,
    reason: 'ok',
    frame: 'trend',
    wayResistance: onTheWay.length > 0 ? onTheWay[0] : null,
  }
}

/**
 * 추세가 없는 종목: 박스 기준.
 *
 * 하락·횡보 종목에 추세 틀(좁은 ATR 손절 + 위쪽 목표)을 쓰면 손익비가 실제보다
 * 좋아 보이는 착시가 생긴다. 그래서 손절은 박스 하단, 목표는 박스 상단으로 잡고
 * 화면에도 "박스 기준"임을 표시해 추세 종목의 숫자와 섞이지 않게 한다.
 */
function rangeFrame(bars: PriceBar[], entry: number): RiskResult {
  if (bars.length < RANGE_WINDOW) return { ...NO_RISK, reason: 'insufficient_data', frame: null }

  const recent20 = bars.slice(-20)
  const atr = computeATR(recent20)
  const swingLow = Math.min(...recent20.map((p) => p.low))
  const stop = swingLow - STOP_BUFFER_ATR_MULT * atr
  if (stop >= entry) return { ...NO_RISK, reason: 'stop_above_entry', frame: 'range' }

  const rangeHigh = Math.max(...bars.slice(-RANGE_WINDOW).map((p) => p.high))
  if (rangeHigh <= entry) return { ...NO_RISK, reason: 'no_upside', frame: 'range' }

  return {
    stop,
    target: rangeHigh,
    riskReward: (rangeHigh - entry) / (entry - stop),
    reason: 'ok',
    frame: 'range',
    wayResistance: null,
  }
}

export function computeStopTarget(bars: PriceBar[], entry: number): RiskResult {
  if (bars.length < 10) return { ...NO_RISK, reason: 'insufficient_data', frame: null }

  const trend = trendStatus(bars)
  if (trend === 'uptrend') return trendFrame(bars, entry)
  if (trend === 'insufficient_data') return { ...NO_RISK, reason: 'insufficient_data', frame: null }
  return rangeFrame(bars, entry)
}
