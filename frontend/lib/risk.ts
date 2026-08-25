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
export const TREND_SMA_PERIOD = 60
const TREND_LOOKBACK = 5

export function computeSMA(bars: PriceBar[], period: number): number | null {
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

// 목표가가 어떤 근거로 나왔는지. 'resistance'/'period_high'는 차트에 실제로 찍힌
// 가격이지만, 'default_2r'은 위쪽에 근거가 없을 때 쓰는 리스크 관리 규칙값이다
// (실제 저항이 아님 — 신고가 부근 종목이 이 경로를 자주 타 손익비가 2.00으로
// 뭉쳐 보이는데, 이는 버그가 아니라 이 기본값이 반복 사용된 결과다). 화면에서
// 두 종류를 구분해 보여줘야 목표가를 차트 근거가 있는 값으로 오인하지 않는다.
export type TargetBasis = 'resistance' | 'period_high' | 'default_2r' | 'range_high'

export interface RiskResult {
  stop: number | null
  target: number | null
  riskReward: number | null
  reason: RiskReason
  frame: RiskFrame | null
  /** 진입가와 목표가 사이에 걸린 첫 저항 — 한 번 막힐 수 있는 지점 */
  wayResistance: number | null
  targetBasis: TargetBasis | null
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

// 횡보 종목의 박스 상단을 재는 창.
const RANGE_WINDOW = 60
// 목표로 인정할 최소 보상(위험 대비). 진입가 코앞의 저항은 목표가 아니라 통과 지점이다.
const MIN_REWARD_R = 1
// 어떤 계산이든 넘지 않는 보상 상한 — 실제 저항이 없을 때 쓰는 2R 기준선도 이 안에 들어온다.
const MAX_REWARD_R = 4

const NO_RISK = { stop: null, target: null, riskReward: null, wayResistance: null, targetBasis: null } as const

/** 상승 추세 종목: 구조적 손절 + 실제 저항 기반 목표 */
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
  const pivotsAbove = findPivotHighs(extended).filter((h) => h > entry)

  // 차트에 실제로 존재하는 가격을 목표로 삼는 것이 우선이다. 다만 보상이 위험보다
  // 작은 저항(진입가 코앞의 전고점)은 목표로서 의미가 없어 건너뛴다 — 이것이
  // 손익비 0.2대를 만들던 원인이었다.
  const meaningful = pivotsAbove.filter((h) => h - entry >= MIN_REWARD_R * risk)

  let target: number
  let targetBasis: TargetBasis
  if (meaningful.length > 0) {
    target = meaningful[0]
    targetBasis = 'resistance'
  } else if (periodHigh > entry + 2 * risk) {
    // 위쪽에 의미 있는 저항은 없지만, 90일 구간 자체 고점은 2R보다 높다 — 그 고점을 쓴다.
    target = periodHigh
    targetBasis = 'period_high'
  } else {
    // 위쪽에 실제 저항도, 그보다 높은 구간 고점도 없음 = 신고가 코앞. 예전엔 여기서
    // 최근 상승폭을 그대로 앞에 투영했는데(임팩트 투영), 그 값이 차트에 한 번도
    // 찍힌 적 없는 가격이라 실제 저항처럼 오인됐다(#29). 이제는 미래를 예측하지
    // 않고 고정 2R을 쓴다 — 이건 차트 근거가 아니라 리스크 관리 규칙값이므로
    // targetBasis로 구분해 화면에 그렇게 표시한다.
    target = entry + 2 * risk
    targetBasis = 'default_2r'
  }

  target = Math.min(target, entry + MAX_REWARD_R * risk)

  // 경유 저항: 목표까지 가는 길에 걸린 첫 저항. 목표를 대체하지 않고
  // "여기서 한 번 막힐 수 있다"를 알리는 용도로만 쓴다.
  const onTheWay = pivotsAbove.filter((h) => h < target)

  return {
    stop,
    target,
    riskReward: (target - entry) / risk,
    reason: 'ok',
    frame: 'trend',
    wayResistance: onTheWay.length > 0 ? onTheWay[0] : null,
    targetBasis,
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
    targetBasis: 'range_high',
  }
}

export function computeStopTarget(bars: PriceBar[], entry: number): RiskResult {
  if (bars.length < 10) return { ...NO_RISK, reason: 'insufficient_data', frame: null }

  const trend = trendStatus(bars)
  if (trend === 'uptrend') return trendFrame(bars, entry)
  if (trend === 'insufficient_data') return { ...NO_RISK, reason: 'insufficient_data', frame: null }
  return rangeFrame(bars, entry)
}
