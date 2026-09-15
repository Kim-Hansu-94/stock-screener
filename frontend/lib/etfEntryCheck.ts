// 490590(RISE 미국AI밸류체인데일리고정커버드콜) 매수 타이밍 체크 — 사용자가 직접
// 정한 개인 매매 체크리스트를 그대로 코드로 옮긴 것이다. 일반적인 스크리닝 알고리즘이
// 아니라 "미국 AI 밸류체인 대장주 5개가 하락을 멈추고 돌아서는가"를 온도계로 써서
// 이 ETF 하나를 언제 얼마씩 살지 판단하는 전용 도구다 — 그래서 종목·금액이 코드에
// 그대로 하드코딩돼 있고, 다른 종목에 재사용하려고 일반화하지 않는다.
//
// 판정 3단계:
//   A(하락 중)  — 최근 고점도 저점도 계속 낮아지는 중. 매수 보류.
//   B(하락 멈춤) — 신저가는 안 만들지만 아직 상승 전환 신호는 안 나옴. 관찰.
//   C(상승 전환) — 20일선 회복 등 상승 전환 조건 다수 충족. 매수 후보.
//
// **이건 검증된 백테스트 전략이 아니라 사용자가 정한 경험적 기준이다.** 판단 근거를
// 전부 숫자로 같이 보여주고(reasons/detail), 뉴스 판단이 필요한 항목(FOMC 발언 성격,
// AI주 동반 하락 여부)은 아예 계산하지 않고 화면에서 네이버 뉴스를 직접 읽게 한다.

import type { PriceHistoryRow } from './types'

export const PROXY_TICKERS = ['ORCL', 'GOOGL', 'NVDA', 'AMD', 'MRVL'] as const
export type ProxyTicker = (typeof PROXY_TICKERS)[number]

export const PROXY_NAMES: Record<ProxyTicker, string> = {
  ORCL: '오라클',
  GOOGL: '알파벳',
  NVDA: '엔비디아',
  AMD: 'AMD',
  MRVL: '마벨 테크놀로지',
}

export const ETF_MARKET = 'KR' as const
export const ETF_TICKER = '490590'
export const ETF_NAME = 'RISE 미국AI밸류체인데일리고정커버드콜'

// ── 판정에 쓰는 구간 길이 (거래일 기준) ──────────────────────────────────
/** 고점/저점이 "계속 낮아지는 중"인지 보는 구간 하나의 길이. 3구간(약 3개월)을 비교한다. */
const STRUCTURE_WINDOW = 20
/** '저점 높이기' 비교에 쓰는 구간 (최근 20일 저점 vs 직전 20일 저점) — supportSignals.ts와 같은 방식. */
const LOW_COMPARE_WINDOW = 20
/** '직전 단기 고점'을 찾을 때, 오늘 포함 최근 며칠은 빼고 그 이전에서 찾는다. */
const BREAKOUT_EXCLUDE_RECENT = 5
const BREAKOUT_LOOKBACK = 20
const SMA_WINDOW = 20
/** 20일선이 "하락을 멈추고 평평해지거나 올라오는지"를 5거래일 전과 비교해서 본다. */
const SMA_TREND_LOOKBACK = 5
const VOLUME_RECENT_WINDOW = 5
const VOLUME_BASE_WINDOW = 20
/** 최근 며칠 안에 신저가가 있었는지 볼 창(동시 이탈·저점 재이탈 판정용). */
const FRESH_LOW_RECENT_DAYS = 3

const MIN_BARS_FOR_STAGE = STRUCTURE_WINDOW * 3 + VOLUME_RECENT_WINDOW + 1

function sma(values: number[], window: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < window - 1) return null
    const slice = values.slice(i - window + 1, i + 1)
    return slice.reduce((a, b) => a + b, 0) / window
  })
}

/** 오늘(마지막 봉)의 저가가 최근 `window`거래일(오늘 제외) 저가보다 더 낮은가 — "신저가". */
function madeFreshLow(lows: number[], window = STRUCTURE_WINDOW): boolean | null {
  if (lows.length < window + 1) return null
  const priorLow = Math.min(...lows.slice(-window - 1, -1))
  return lows[lows.length - 1] < priorLow
}

/** 최근 `recentDays`일 중 하루라도 신저가를 만들었는가 — 하루 지연을 두어 "동시성"을 조금 느슨하게 본다. */
function madeFreshLowRecently(bars: PriceHistoryRow[], recentDays = FRESH_LOW_RECENT_DAYS): boolean | null {
  if (bars.length < STRUCTURE_WINDOW + recentDays) return null
  const lows = bars.map((b) => b.low)
  for (let cut = 0; cut < recentDays; cut++) {
    const upTo = lows.length - cut
    if (madeFreshLow(lows.slice(0, upTo))) return true
  }
  return false
}

export type TrendStage = 'A' | 'B' | 'C'

export const STAGE_LABEL: Record<TrendStage, string> = {
  A: '하락 중',
  B: '하락 멈춤 (관찰)',
  C: '상승 전환',
}

export interface StageResult {
  stage: TrendStage
  label: string
  /** 판정 근거를 사람이 읽는 문장으로 나열 — 왜 이 단계인지 그대로 보여준다. */
  reasons: string[]
  detail: {
    close: number
    date: string
    sma20: number | null
    aboveSma20: boolean | null
    sma20Rising: boolean | null
    brokeRecentHigh: boolean | null
    higherLow: boolean | null
    volumeUp: boolean | null
    lowerHighsAndLows: boolean
    freshLow: boolean | null
  }
}

/**
 * 일봉(오름차순: 과거→최신)을 받아 A/B/C 단계를 판정한다.
 * 데이터가 부족하면 null(판정 불가) — 이걸 미충족(A)으로 잘못 세면 안 된다.
 */
export function classifyStage(bars: PriceHistoryRow[]): StageResult | null {
  if (bars.length < MIN_BARS_FOR_STAGE) return null

  const closes = bars.map((b) => b.close)
  const highs = bars.map((b) => b.high)
  const lows = bars.map((b) => b.low)
  const volumes = bars.map((b) => b.volume)
  const latest = bars[bars.length - 1]
  const latestClose = closes[closes.length - 1]

  // A. 고점·저점이 3구간 연속으로 낮아지는가.
  const seg = <T>(arr: T[]) => [
    arr.slice(arr.length - STRUCTURE_WINDOW * 3, arr.length - STRUCTURE_WINDOW * 2),
    arr.slice(arr.length - STRUCTURE_WINDOW * 2, arr.length - STRUCTURE_WINDOW),
    arr.slice(arr.length - STRUCTURE_WINDOW),
  ]
  const [hSeg1, hSeg2, hSeg3] = seg(highs)
  const [lSeg1, lSeg2, lSeg3] = seg(lows)
  const h1 = Math.max(...hSeg1), h2 = Math.max(...hSeg2), h3 = Math.max(...hSeg3)
  const l1 = Math.min(...lSeg1), l2 = Math.min(...lSeg2), l3 = Math.min(...lSeg3)
  const lowerHighs = h1 > h2 && h2 > h3
  const lowerLows = l1 > l2 && l2 > l3
  const isDowntrend = lowerHighs && lowerLows

  // C 후보 조건 5개 — 3개 이상 충족하면 상승 전환으로 본다.
  const smaSeries = sma(closes, SMA_WINDOW)
  const sma20 = smaSeries[smaSeries.length - 1]
  const sma20Prior = smaSeries[smaSeries.length - 1 - SMA_TREND_LOOKBACK] ?? null
  const aboveSma20 = sma20 !== null ? latestClose > sma20 : null
  const sma20Rising = sma20 !== null && sma20Prior !== null ? sma20 > sma20Prior : null

  const recentSwingHigh = Math.max(
    ...highs.slice(-(BREAKOUT_LOOKBACK + BREAKOUT_EXCLUDE_RECENT), -BREAKOUT_EXCLUDE_RECENT),
  )
  const brokeRecentHigh = latestClose > recentSwingHigh

  const recentLow = Math.min(...lows.slice(-LOW_COMPARE_WINDOW))
  const priorLow = Math.min(...lows.slice(-LOW_COMPARE_WINDOW * 2, -LOW_COMPARE_WINDOW))
  const higherLow = recentLow > priorLow

  const recentVol = volumes.slice(-VOLUME_RECENT_WINDOW).reduce((a, b) => a + b, 0) / VOLUME_RECENT_WINDOW
  const baseVol =
    volumes.slice(-(VOLUME_RECENT_WINDOW + VOLUME_BASE_WINDOW), -VOLUME_RECENT_WINDOW).reduce((a, b) => a + b, 0) /
    VOLUME_BASE_WINDOW
  const volumeUp = baseVol > 0 ? recentVol > baseVol : null

  const cConditions = [aboveSma20, sma20Rising, brokeRecentHigh, higherLow, volumeUp]
  const cMetCount = cConditions.filter((c) => c === true).length
  const isUptrendConfirmed = cMetCount >= 3

  const freshLow = madeFreshLow(lows)

  let stage: TrendStage
  const reasons: string[] = []
  if (isDowntrend) {
    stage = 'A'
    reasons.push(`최근 3구간(각 ${STRUCTURE_WINDOW}일) 고점이 계속 낮아짐`)
    reasons.push(`최근 3구간 저점도 계속 낮아짐`)
  } else if (isUptrendConfirmed) {
    stage = 'C'
    if (aboveSma20) reasons.push(`${SMA_WINDOW}일선(${sma20?.toFixed(2)}) 위로 회복`)
    if (sma20Rising) reasons.push(`${SMA_WINDOW}일선이 ${SMA_TREND_LOOKBACK}거래일 전보다 상승 중`)
    if (brokeRecentHigh) reasons.push(`직전 단기 고점(${recentSwingHigh.toFixed(2)}) 돌파`)
    if (higherLow) reasons.push('저점이 높아지는 중')
    if (volumeUp) reasons.push('거래량이 평소보다 증가')
  } else {
    stage = 'B'
    reasons.push('고점·저점이 계속 낮아지는 하락 추세는 멈췄지만')
    reasons.push(`상승 전환 조건은 5개 중 ${cMetCount}개만 충족 (3개 이상 필요)`)
  }

  return {
    stage,
    label: STAGE_LABEL[stage],
    reasons,
    detail: {
      close: latestClose,
      date: latest.date,
      sma20,
      aboveSma20,
      sma20Rising,
      brokeRecentHigh,
      higherLow,
      volumeUp,
      lowerHighsAndLows: isDowntrend,
      freshLow,
    },
  }
}

// ── 5개 대장주 종합 신호등 ────────────────────────────────────────────────

export interface ProxyBasketAssessment {
  perTicker: Record<ProxyTicker, StageResult | null>
  /** 상승 전환(C) 단계인 종목 수 */
  cStageCount: number
  /** 데이터가 있어 실제로 판정된 종목 수 (5개 미만이면 신호등이 아직 미완성) */
  evaluatedCount: number
  trafficLight: string
  trafficLabel: string
}

function trafficLightFor(cCount: number): { emoji: string; label: string } {
  if (cCount <= 1) return { emoji: '🔴', label: '매수 보류 — 대장주 대부분이 아직 하락·관찰 단계' }
  if (cCount === 2) return { emoji: '🟠', label: '관찰 — 상승 전환 조짐이 늘고 있음' }
  if (cCount === 3) return { emoji: '🟡', label: '1차 매수 검토 가능' }
  if (cCount === 4) return { emoji: '🟢', label: '적극적 분할매수 검토 가능' }
  return { emoji: '🟢🟢', label: '강한 상승 확인 — 대장주 전부 상승 전환' }
}

export function assessProxyBasket(
  barsByTicker: Record<ProxyTicker, PriceHistoryRow[] | undefined>,
): ProxyBasketAssessment {
  const perTicker = {} as Record<ProxyTicker, StageResult | null>
  for (const t of PROXY_TICKERS) perTicker[t] = classifyStage(barsByTicker[t] ?? [])

  const evaluated = PROXY_TICKERS.map((t) => perTicker[t]).filter((r): r is StageResult => r !== null)
  const cStageCount = evaluated.filter((r) => r.stage === 'C').length
  const { emoji, label } = trafficLightFor(cStageCount)

  return {
    perTicker,
    cStageCount,
    evaluatedCount: evaluated.length,
    trafficLight: emoji,
    trafficLabel: label,
  }
}

// ── 1~4차 분할매수 가이드 ────────────────────────────────────────────────
// 총 5,000만원을 500 → 1,500 → 1,500 → 1,500만원으로 나눠 넣는 계획. 자동으로
// 판정 가능한 조건만 "충족 여부"로 표시하고, 판단이 필요한 항목은 별도로 안내한다
// (자동 조건이 다 충족돼도 매수를 강제하지 않는다 — 최종 결정은 항상 사용자 몫).

export interface TrancheCondition {
  text: string
  met: boolean
}

export interface TrancheStep {
  order: 1 | 2 | 3 | 4
  amountManwon: number
  cumulativeManwon: number
  label: string
  autoConditions: TrancheCondition[]
  /** 뉴스 등으로 직접 판단해야 하는 항목 — 자동 판정에 넣지 않는다. */
  manualConditions: string[]
  /** autoConditions가 전부 충족됐는가 (manualConditions는 별도로 확인 필요). */
  autoReady: boolean
}

/** 최근 `window`일 안에서 오늘 종가가 신고가인가 — "추가로 고점을 높임" 판정에 쓴다. */
function madeFreshHigh(bars: PriceHistoryRow[], window = BREAKOUT_LOOKBACK): boolean | null {
  if (bars.length < window + 1) return null
  const highs = bars.map((b) => b.high)
  const priorHigh = Math.max(...highs.slice(-window - 1, -1))
  return highs[highs.length - 1] > priorHigh
}

export function buildTrancheGuide(
  proxy: ProxyBasketAssessment,
  etfStage: StageResult | null,
  etfBars: PriceHistoryRow[],
): TrancheStep[] {
  const etfNotDowntrend = etfStage !== null ? etfStage.stage !== 'A' : false
  const etfAboveSma20 = etfStage?.detail.aboveSma20 ?? false
  const etfBrokeHigh = etfStage?.detail.brokeRecentHigh ?? false
  const etfFreshHigh = madeFreshHigh(etfBars) ?? false

  return [
    {
      order: 1,
      amountManwon: 500,
      cumulativeManwon: 500,
      label: '1차 — 시장에 발을 걸치는 매수',
      autoConditions: [
        { text: '구성종목 5개 중 2개 이상 상승 전환', met: proxy.cStageCount >= 2 },
        { text: '490590이 저점을 방어 중 (하락 추세 아님)', met: etfNotDowntrend },
      ],
      manualConditions: ['FOMC 충격이 진정되는 모습인지 (아래 뉴스 참고)'],
      autoReady: proxy.cStageCount >= 2 && etfNotDowntrend,
    },
    {
      order: 2,
      amountManwon: 1500,
      cumulativeManwon: 2000,
      label: '2차',
      autoConditions: [
        { text: '구성종목 5개 중 3개 이상 상승 전환', met: proxy.cStageCount >= 3 },
        { text: '490590 20일선 회복', met: etfAboveSma20 },
        { text: '490590 직전 단기 고점 돌파', met: etfBrokeHigh },
      ],
      manualConditions: [],
      autoReady: proxy.cStageCount >= 3 && etfAboveSma20 && etfBrokeHigh,
    },
    {
      order: 3,
      amountManwon: 1500,
      cumulativeManwon: 3500,
      label: '3차',
      autoConditions: [
        { text: 'AI 구성종목 대부분 상승 (5개 중 4개 이상)', met: proxy.cStageCount >= 4 },
        { text: '490590이 추가로 고점을 높임', met: etfFreshHigh },
      ],
      manualConditions: ['나스닥 추세가 안정적인지 (아래 뉴스 참고)'],
      autoReady: proxy.cStageCount >= 4 && etfFreshHigh,
    },
    {
      order: 4,
      amountManwon: 1500,
      cumulativeManwon: 5000,
      label: '4차 — 무조건 넣을 필요 없음',
      autoConditions: [
        { text: '3차 조건이 흔들림 없이 계속 유지', met: proxy.cStageCount >= 4 && etfFreshHigh },
      ],
      manualConditions: ['조건이 확실하지 않으면 남은 돈은 투자하지 않는다 — "많이 떨어졌으니 오르겠지"는 금지'],
      autoReady: proxy.cStageCount >= 4 && etfFreshHigh,
    },
  ]
}

// ── 매수 중단 신호 ────────────────────────────────────────────────────────

export interface StopSignal {
  id: string
  label: string
  /** null = 데이터 부족으로 계산 불가, undefined 아님 — 자동판정 대상인데 데이터가 모자란 경우. */
  triggered: boolean | null
  detail: string
  /** false면 뉴스 등으로 직접 판단해야 하는 항목(계산하지 않음). */
  automatic: boolean
}

export function assessStopSignals(
  etfBars: PriceHistoryRow[],
  proxyBars: Record<ProxyTicker, PriceHistoryRow[] | undefined>,
  tenYearYield: { close: number; prevClose: number } | null,
): StopSignal[] {
  const etfFreshLow = etfBars.length > 0 ? madeFreshLow(etfBars.map((b) => b.low)) : null

  const proxyFreshLowCount = PROXY_TICKERS.reduce((count, t) => {
    const bars = proxyBars[t]
    return madeFreshLowRecently(bars ?? []) ? count + 1 : count
  }, 0)

  // ^TNX는 수익률(%)의 10배로 온다 (4.50% → 45.00) — 1.5 차이가 약 15bp(0.15%p) 급등.
  const YIELD_SPIKE_THRESHOLD_RAW = 1.5
  const yieldChange = tenYearYield ? tenYearYield.close - tenYearYield.prevClose : null
  const yieldSpike = yieldChange !== null ? yieldChange >= YIELD_SPIKE_THRESHOLD_RAW : null

  const proxyStages = PROXY_TICKERS.map((t) => classifyStage(proxyBars[t] ?? []))
  const evaluatedStages = proxyStages.filter((s): s is StageResult => s !== null)
  const aStageCount = evaluatedStages.filter((s) => s.stage === 'A').length
  const allDownTogether =
    evaluatedStages.length >= 4 ? aStageCount >= evaluatedStages.length - 1 : null

  return [
    {
      id: 'etfFreshLow',
      label: '490590이 최근 저점을 재차 이탈',
      triggered: etfFreshLow,
      detail:
        etfFreshLow === null
          ? '일봉 데이터 부족'
          : etfFreshLow
            ? `최근 ${STRUCTURE_WINDOW}거래일 저가보다 더 낮은 저가 발생`
            : '아직 최근 저점 아래로는 안 내려감',
      automatic: true,
    },
    {
      id: 'proxyFreshLow',
      label: '대장주 여러 개가 동시에 저점 이탈',
      triggered: proxyFreshLowCount >= 3 ? true : proxyFreshLowCount > 0 ? false : null,
      detail: `최근 ${FRESH_LOW_RECENT_DAYS}거래일 안에 신저가를 만든 대장주 ${proxyFreshLowCount}/5개 (3개 이상이면 경고)`,
      automatic: true,
    },
    {
      id: 'yieldSpike',
      label: '미국 10년물 금리 급등',
      triggered: yieldSpike,
      detail:
        yieldChange === null
          ? '금리 데이터 없음 (다음 파이프라인 실행 후 표시)'
          : `전일 대비 ${(yieldChange / 10).toFixed(2)}%p 변동 (기준: ${(YIELD_SPIKE_THRESHOLD_RAW / 10).toFixed(2)}%p 이상)`,
      automatic: true,
    },
    {
      id: 'allDownTogether',
      label: 'AI주 전체가 동반 하락',
      triggered: allDownTogether,
      detail:
        allDownTogether === null
          ? '판정 종목 부족'
          : `대장주 ${aStageCount}/${evaluatedStages.length}개가 하락 단계`,
      automatic: true,
    },
    {
      id: 'nasdaqGiveback',
      label: '나스닥이 강한 상승 후 상승분을 모두 반납',
      triggered: null,
      detail: '장중 고가 데이터가 없어 자동 계산 불가 — 직접 확인 필요',
      automatic: false,
    },
    {
      id: 'hawkishFomc',
      label: 'FOMC 이후 매파적 분위기가 계속됨',
      triggered: null,
      detail: '뉴스를 읽고 직접 판단 — 아래 뉴스 참고',
      automatic: false,
    },
  ]
}
