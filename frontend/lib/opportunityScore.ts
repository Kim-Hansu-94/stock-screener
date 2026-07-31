// "매수 매력도" scoring for the 횡보·조정 (sideways consolidation) screener.
// Hard filters reject stocks still in free-fall or not actually basing, then a
// weighted score ranks how well the base is formed: seller exhaustion, volatility
// contraction, higher lows, and volume dry-up, plus turn-signal bonuses.
//
// NOTE: 실제 채점은 이제 파이프라인이 수행한다 (pipeline/src/watchlist.py의
// evaluate_watch → opportunity_snapshot). 이 파일은 그 포팅의 기준이 되는
// 참조 구현이며, 함께 있는 테스트가 알고리즘의 명세 역할을 한다. 상수나 계산을
// 바꿀 때는 watchlist.py도 반드시 같이 바꿔야 두 쪽이 갈라지지 않는다.

export interface DailyBar {
  date: string
  close: number
  high: number
  low: number
  volume: number
}

export interface OpportunitySignals {
  /** 0~1 composite buy-attractiveness score */
  score: number
  /** Trading days since the 52-week low was last touched */
  daysSinceLow: number
  /** ATR20/ATR60 ≤ 0.8 — volatility contraction pattern */
  vcp: boolean
  /** Recent 60d low sits above the prior 60d low */
  higherLows: boolean
  /** 20d volume has dried up vs the prior 40d */
  volumeDry: boolean
  /** close > SMA5 > SMA20 > SMA60 */
  alignedMAs: boolean
  /** Latest volume ≥ 2× its 90d average */
  volumeTrigger: boolean
}

// 저점 높이기 비교 창. 60일(6개월) 대비로는 장기 하락 중의 중간 반등도 "저점이
// 올라왔다"로 잡혀, 계단식 하락의 계단참을 바닥으로 오인했다. 120일씩(총 1년)
// 비교해 한 해 단위로 저점이 실제로 올라왔는지를 본다.
const HIGHER_LOW_WINDOW = 120
// 저점 높이기 비교에 2구간(240봉)이 필요하다.
const MIN_BARS = HIGHER_LOW_WINDOW * 2
const YEAR_WINDOW = 252
const RECENT_LOW_WINDOW = 20
const BOX_WINDOW = 60
const MAX_BOX_RANGE = 0.3
const EXHAUSTION_CAP_DAYS = 120

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const sma = (closes: number[], period: number) => mean(closes.slice(-period))

function atr(bars: DailyBar[], period: number): number {
  const window = bars.slice(-(period + 1))
  const trs: number[] = []
  for (let i = 1; i < window.length; i++) {
    const { high, low } = window[i]
    const prevClose = window[i - 1].close
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)))
  }
  return mean(trs)
}

/**
 * Scores a stock that already passed the 20–60% drawdown filter.
 * Returns null when data is insufficient or a hard filter rejects it.
 */
export function scoreOpportunity(bars: DailyBar[]): OpportunitySignals | null {
  if (bars.length < MIN_BARS) return null

  const yearBars = bars.slice(-Math.min(YEAR_WINDOW, bars.length))
  const lows = yearBars.map((b) => b.low)

  // 하드 필터 1 — 하락 진행 중 제외: 최근 20거래일 내 52주 신저가 갱신 없음
  const recentLows = lows.slice(-RECENT_LOW_WINDOW)
  const priorLows = lows.slice(0, -RECENT_LOW_WINDOW)
  if (Math.min(...recentLows) < Math.min(...priorLows)) return null

  // 하드 필터 2 — 횡보 확인: 최근 60거래일 박스폭 (최고−최저)/최저 ≤ 30%
  const boxBars = bars.slice(-BOX_WINDOW)
  const boxHigh = Math.max(...boxBars.map((b) => b.high))
  const boxLow = Math.min(...boxBars.map((b) => b.low))
  if ((boxHigh - boxLow) / boxLow > MAX_BOX_RANGE) return null

  // 하드 필터 3 — 거래정지/유동성 전무 제외: 거래량 평균이 0이면 매수 자체가
  // 불가능하고, 아래 거래량 비율 계산이 0/0 = NaN이 되어 점수를 오염시킨다
  const volumes = bars.map((b) => b.volume)
  if (mean(volumes.slice(-20)) <= 0 || mean(volumes.slice(-60, -20)) <= 0) return null

  // 매도 소진 (0.30): 52주 저점을 마지막으로 찍은 뒤 경과 거래일
  const yearLow = Math.min(...lows)
  const daysSinceLow = lows.length - 1 - lows.lastIndexOf(yearLow)
  const exhaustionScore = clamp01(daysSinceLow / EXHAUSTION_CAP_DAYS)

  // 변동성 수축 VCP (0.25): ATR20/ATR60 낮을수록 좋음 (0.6 이하 만점, 1.0 이상 0점)
  // ATR60이 0(장기간 가격 고정)이면 0/0 = NaN이 되므로 수축 정보 없음(1)으로 처리
  const atr60 = atr(bars, 60)
  const vcpRatio = atr60 > 0 ? atr(bars, 20) / atr60 : 1
  const vcpScore = clamp01((1 - vcpRatio) / 0.4)

  // 저점 높이기 (0.25): 최근 120일 저점 > 그 앞 120일 저점 (1년 단위 비교)
  const recentLow = Math.min(...bars.slice(-HIGHER_LOW_WINDOW).map((b) => b.low))
  const priorLow = Math.min(
    ...bars.slice(-HIGHER_LOW_WINDOW * 2, -HIGHER_LOW_WINDOW).map((b) => b.low),
  )
  const higherLows = recentLow > priorLow

  // 거래량 소진 (0.20): 최근 20일 / 직전 40일 거래량 비율, 0.5~0.8 구간이 최고점
  const volRatio = mean(volumes.slice(-20)) / mean(volumes.slice(-60, -20))
  const volumeDryScore =
    volRatio < 0.5
      ? clamp01((volRatio - 0.2) / 0.3)
      : volRatio <= 0.8
        ? 1
        : clamp01((1.2 - volRatio) / 0.4)

  let score =
    0.3 * exhaustionScore +
    0.25 * vcpScore +
    0.25 * (higherLows ? 1 : 0) +
    0.2 * volumeDryScore

  // 보너스 — 이평 정배열: 종가 > SMA5 > SMA20 > SMA60 (+0.10)
  const closes = bars.map((b) => b.close)
  const lastClose = closes[closes.length - 1]
  const sma5 = sma(closes, 5)
  const sma20 = sma(closes, 20)
  const sma60 = sma(closes, 60)
  const alignedMAs = lastClose > sma5 && sma5 > sma20 && sma20 > sma60
  if (alignedMAs) score += 0.1

  // 보너스 — 거래량 트리거: 당일 거래량 ≥ 90일 평균 2배 (+0.10)
  const volumeTrigger =
    volumes[volumes.length - 1] >= 2 * mean(volumes.slice(-90))
  if (volumeTrigger) score += 0.1

  return {
    score: Math.min(1, score),
    daysSinceLow,
    vcp: vcpRatio <= 0.8,
    higherLows,
    volumeDry: volumeDryScore >= 0.6,
    alignedMAs,
    volumeTrigger,
  }
}
