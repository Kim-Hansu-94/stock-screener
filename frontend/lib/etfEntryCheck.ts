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

/**
 * 몸통 ÷ (고가-저가)가 이 값 이하면 십자형(도지)으로 본다.
 * `pipeline/src/pattern_discovery.py`의 `DOJI_BODY_RATIO`와 같은 값 — 같은 판정을
 * 두 곳에서 다르게 하면 안 된다.
 */
const DOJI_BODY_RATIO = 0.1

/**
 * 최근 구간의 거래량이 **사는 쪽이었는지** — 양봉·십자형 날 거래량이 전체에서 차지하는 비중.
 *
 * 거래량이 늘었다는 것만으로는 방향을 알 수 없다. 『매매의 기술』(2장 거래량):
 * **"거래량은 타이밍만 제공한다. 방향은 봉의 모양이 결정한다."** 같은 책이 거래량 8원칙
 * 2번에서 "거래량 증가 + 장대음봉 = **매물**"이라고 정반대로 못 박는다.
 *
 * 이 저장소는 이미 같은 실수를 한 번 했다 — `pattern_discovery.py`의 거래량 트리거가
 * 거래량 2배만 보고 **투매(대량거래 장대음봉)에도 매수 신호 배지를 붙였다**(2026-09-14 수정).
 * 여기도 똑같이 "5일 평균이 늘었나"만 보고 있어서, **던지느라 터진 거래량**을 매수세로
 * 세고 있었다.
 *
 * 하루가 아니라 구간을 보므로 봉 하나의 모양 대신 **양봉 쪽 거래량 비중**으로 잰다.
 * 0.5면 양쪽이 같고, 그보다 크면 오른 날에 거래가 더 실렸다는 뜻이다.
 *
 * 전 구간 시가=종가인 소스(시가를 종가로 메운 데이터)는 모든 봉이 십자형으로 잡혀
 * 비중이 항상 1이 된다 — 그런 입력은 `null`(판정 불가)로 돌려준다.
 */
function buyingVolumeShare(bars: PriceHistoryRow[]): number | null {
  let buying = 0
  let selling = 0
  let hasAnyBody = false
  for (const bar of bars) {
    if (bar.close !== bar.open) hasAnyBody = true
    const range = bar.high - bar.low
    const isDoji = range > 0 && Math.abs(bar.close - bar.open) / range <= DOJI_BODY_RATIO
    if (bar.close > bar.open || isDoji) buying += bar.volume
    else selling += bar.volume
  }
  if (!hasAnyBody) return null
  const total = buying + selling
  return total > 0 ? buying / total : null
}

/**
 * 판정 근거에 찍을 가격 포맷. 국내 ETF(13,505원)와 미국 주식(180.52달러)을 같은
 * 함수가 처리하므로, 1,000 이상이면 정수+콤마, 미만이면 소수 둘째 자리까지 쓴다 —
 * 전부 정수로 자르면 미국 주식의 소수점 차이가 통째로 사라진다.
 */
function fmtPrice(v: number): string {
  return v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2)
}

export type TrendStage = 'A' | 'B' | 'C'

/** 상승 전환(C) 판정에 쓰는 5개 조건 중 하나 — 화면이 이름과 숫자를 그대로 보여준다. */
export interface UpturnCondition {
  label: string
  /** 이 조건이 무엇을 보는지 한 줄 설명 (조건 이름만으론 뜻이 안 통해서) */
  why: string
  met: boolean
  /** 왜 그렇게 판정했는지 보여줄 실제 숫자 */
  detail: string
}

/** 5개 중 이만큼 충족하면 상승 전환으로 본다. */
export const UPTURN_REQUIRED = 3

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
  /** 상승 전환 조건 5개의 이름·충족 여부·근거 숫자 (단계와 무관하게 항상 채운다). */
  upturnConditions: UpturnCondition[]
  /** 그중 충족한 개수 */
  upturnMetCount: number
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
  const volumeGrew = baseVol > 0 ? recentVol > baseVol : null
  // 늘어난 거래량이 사는 쪽이었는지까지 봐야 한다 — 위 buyingVolumeShare 주석 참고.
  // 0.5는 "오른 날과 내린 날에 똑같이 실렸다"는 중립선이지 조정한 임계값이 아니다.
  const buyingShare = buyingVolumeShare(bars.slice(-VOLUME_RECENT_WINDOW))
  const volumeUp =
    volumeGrew === null || buyingShare === null ? null : volumeGrew && buyingShare >= 0.5

  // 조건 이름을 값과 같은 자리에서 만든다 — 화면이 "5개 중 1개 충족"이라고만 말하고
  // **어떤 조건인지는 안 알려줘서** 무슨 소린지 모르겠다는 지적을 받았다(2026-09-15).
  // `why`는 조건 자체를 처음 보는 사람을 위한 한 줄 설명이고, `detail`은 그 판정에
  // 실제로 쓴 숫자다 — 둘을 합치면 "왜 이게 조건인지"와 "지금 얼마인지"가 같이 보인다.
  const upturnConditions: UpturnCondition[] = [
    {
      label: `${SMA_WINDOW}일선 회복`,
      why: `최근 ${SMA_WINDOW}거래일 평균 가격보다 오늘 종가가 위에 있는가`,
      met: aboveSma20 === true,
      detail:
        sma20 !== null
          ? `종가 ${fmtPrice(latestClose)} vs ${SMA_WINDOW}일선 ${fmtPrice(sma20)}`
          : '계산 불가',
    },
    {
      label: `${SMA_WINDOW}일선이 더는 안 떨어짐`,
      why: '평균선 자체가 내려가기를 멈췄는가 (추세가 꺾였다는 뜻)',
      met: sma20Rising === true,
      detail:
        sma20 !== null && sma20Prior !== null
          ? `${SMA_TREND_LOOKBACK}거래일 전 ${fmtPrice(sma20Prior)} → 지금 ${fmtPrice(sma20)}`
          : '계산 불가',
    },
    {
      label: '직전 단기 고점 돌파',
      why: '최근에 막혔던 가격대를 뚫고 올라섰는가',
      met: brokeRecentHigh,
      detail: `직전 고점 ${fmtPrice(recentSwingHigh)} vs 종가 ${fmtPrice(latestClose)}`,
    },
    {
      label: '저점이 높아짐',
      why: '더 싸게 팔려는 사람이 줄었는가 (바닥이 올라오는 모양)',
      met: higherLow,
      detail: `최근 ${LOW_COMPARE_WINDOW}일 최저 ${fmtPrice(recentLow)} vs 그 이전 ${fmtPrice(priorLow)}`,
    },
    {
      label: '사는 거래량이 늘어남',
      why: '거래량이 늘었고, 그게 던지는 쪽이 아니라 사는 쪽이었는가',
      met: volumeUp === true,
      detail:
        baseVol > 0 && buyingShare !== null
          ? `최근 ${VOLUME_RECENT_WINDOW}일 평균이 그 이전 ${VOLUME_BASE_WINDOW}일의 ${(recentVol / baseVol).toFixed(1)}배 · 그중 오른 날 거래량 비중 ${(buyingShare * 100).toFixed(0)}%`
          : '계산 불가',
    },
  ]
  const cMetCount = upturnConditions.filter((c) => c.met).length
  const isUptrendConfirmed = cMetCount >= UPTURN_REQUIRED

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
    if (volumeUp) reasons.push('거래량이 늘었고 오른 날에 더 실림')
  } else {
    stage = 'B'
    reasons.push('고점·저점이 계속 낮아지는 하락 추세는 멈췄지만')
    reasons.push(`상승 전환 조건은 5개 중 ${cMetCount}개만 충족 (3개 이상 필요)`)
  }

  return {
    stage,
    label: STAGE_LABEL[stage],
    reasons,
    upturnConditions,
    upturnMetCount: cMetCount,
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
//
// **상태에 따라 문장 자체가 바뀐다.** 예전에는 "490590이 최근 저점을 재차 이탈"처럼
// 나쁜 일의 이름을 제목으로 놓고 그 옆에 ✓/🚨를 붙였는데, 그러면 읽는 사람이 제목과
// 기호를 머릿속에서 곱해야 하고 ✓가 "그 나쁜 일이 일어났다"로 정반대로 읽힌다
// (2026-09-15 사용자 지적). 지금은 headline이 현재 상태를 그대로 서술하므로
// 문장만 읽어도 뜻이 통하고, 배지는 글자('이상 없음'/'경고')로 거든다.

/** ok = 이 신호는 안 걸림 / alert = 걸림(멈출 이유) / unknown = 데이터가 없어 판단 불가 */
export type StopSignalState = 'ok' | 'alert' | 'unknown'

export interface StopSignal {
  id: string
  /** 무엇을 보는 항목인지 — 좋고 나쁨이 섞이지 않은 중립적 이름 */
  topic: string
  state: StopSignalState
  /** 지금 상태를 그대로 쓴 한 문장 (상태에 따라 내용이 바뀐다) */
  headline: string
  /** 그렇게 판단한 근거를 쉬운 말로 */
  detail: string
}

/**
 * 뉴스를 읽어야 알 수 있어 자동으로 판단하지 않는 항목. 계산이 없으므로 상수다 —
 * 화면은 이걸 "직접 확인할 것" 목록으로 따로 떼어 보여준다(자동 판정과 섞지 않는다).
 */
export interface ManualStopCheck {
  id: string
  /** 사용자가 스스로 답할 수 있는 질문 형태 */
  question: string
  /** 왜 자동으로 못 보는지 */
  why: string
}

export const MANUAL_STOP_CHECKS: ManualStopCheck[] = [
  {
    id: 'nasdaqGiveback',
    question: '나스닥이 크게 올랐다가 그날 오른 만큼을 다시 다 반납했나요?',
    why: '이 사이트는 하루 종가만 받고 장중 가격은 안 받아서 자동으로 알 수 없습니다.',
  },
  {
    id: 'hawkishFomc',
    question: 'FOMC 뒤에도 연준이 계속 매파적인가요? (금리를 더 올리거나 높은 채로 오래 두겠다는 태도)',
    why: '발언의 분위기는 뉴스를 읽어야 알 수 있습니다 — 아래 뉴스를 참고하세요.',
  },
]

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
  const proxyEvaluated = PROXY_TICKERS.filter((t) => (proxyBars[t]?.length ?? 0) > 0).length

  // **^TNX는 퍼센트 값을 그대로 준다** (5.02 = 5.02%). CBOE 지수 원값은 수익률의
  // 10배지만 yfinance가 이미 나눠서 준다 — 처음엔 10배로 알고 또 10으로 나눠서
  // 5.02%가 화면에 0.50%로 떴다(2026-09-15, 뉴스의 "10년물 5.02%"와 대조해 발견).
  // 단위를 바꾸기 전에 `db_probe`의 market_index_snapshot 출력으로 저장값을 볼 것.
  const YIELD_SPIKE_THRESHOLD_PCT = 0.15
  const yieldChange = tenYearYield ? tenYearYield.close - tenYearYield.prevClose : null
  const yieldSpike = yieldChange !== null ? yieldChange >= YIELD_SPIKE_THRESHOLD_PCT : null
  // %p라는 말을 안 쓰고 "어제 4.99% → 오늘 5.02%"로 보여준다 — 단위를 몰라도 읽힌다.
  // "오늘"이라고 쓰면 안 된다 — 미국장은 한국 새벽에 닫히고 파이프라인은 하루 두 번만
  // 도는데, 둘 다 미국장이 닫혀 있는 시각이라 여기 들어오는 건 **직전에 끝난 미국장
  // 종가**다(2026-09-15 16:49 KST 실행 기준 9/14 종가). 날짜는 화면이 따로 밝힌다.
  const yieldText = tenYearYield
    ? `직전 ${tenYearYield.prevClose.toFixed(2)}% → 최근 ${tenYearYield.close.toFixed(2)}%`
    : ''

  const proxyStages = PROXY_TICKERS.map((t) => classifyStage(proxyBars[t] ?? []))
  const evaluatedStages = proxyStages.filter((s): s is StageResult => s !== null)
  const aStageCount = evaluatedStages.filter((s) => s.stage === 'A').length
  const allDownTogether =
    evaluatedStages.length >= 4 ? aStageCount >= evaluatedStages.length - 1 : null

  return [
    {
      id: 'etfFreshLow',
      topic: '490590이 바닥을 지키고 있나',
      state: etfFreshLow === null ? 'unknown' : etfFreshLow ? 'alert' : 'ok',
      headline:
        etfFreshLow === null
          ? '490590 일봉이 아직 모자라 판단할 수 없습니다'
          : etfFreshLow
            ? '490590이 최근 바닥을 깨고 더 내려갔습니다'
            : '490590이 최근 바닥을 잘 지키고 있습니다',
      detail:
        etfFreshLow === null
          ? '가격 데이터가 쌓이면 자동으로 판단합니다'
          : etfFreshLow
            ? `최근 ${STRUCTURE_WINDOW}거래일 중 가장 쌌던 가격보다 더 싸게 거래됐습니다`
            : `최근 ${STRUCTURE_WINDOW}거래일 중 가장 쌌던 가격 아래로는 안 내려갔습니다`,
    },
    {
      id: 'proxyFreshLow',
      topic: '대장주들이 한꺼번에 무너지고 있나',
      state: proxyEvaluated === 0 ? 'unknown' : proxyFreshLowCount >= 3 ? 'alert' : 'ok',
      headline:
        proxyEvaluated === 0
          ? '대장주 가격 데이터가 없어 판단할 수 없습니다'
          : proxyFreshLowCount >= 3
            ? `대장주 ${proxyFreshLowCount}개가 한꺼번에 바닥을 깼습니다`
            : '대장주가 한꺼번에 무너지는 모습은 아닙니다',
      detail:
        proxyEvaluated === 0
          ? '가격 데이터가 쌓이면 자동으로 판단합니다'
          : `최근 ${FRESH_LOW_RECENT_DAYS}거래일 안에 바닥을 깬 대장주 ${proxyFreshLowCount}개 (5개 중 3개 이상이면 경고)`,
    },
    {
      id: 'yieldSpike',
      topic: '미국 금리가 갑자기 튀었나',
      state: yieldSpike === null ? 'unknown' : yieldSpike ? 'alert' : 'ok',
      headline:
        yieldSpike === null
          ? '금리 데이터가 아직 없습니다'
          : yieldSpike
            ? '미국 국채 금리가 하루 만에 크게 올랐습니다'
            : '미국 국채 금리는 잠잠합니다',
      detail:
        yieldSpike === null
          ? '다음 자동 수집(하루 2번) 뒤부터 표시됩니다'
          : `미국 10년물 국채 금리 ${yieldText} · 하루에 0.15%p 넘게 오르면 경고로 봅니다`,
    },
    {
      id: 'allDownTogether',
      topic: 'AI 대장주 전체 분위기',
      state: allDownTogether === null ? 'unknown' : allDownTogether ? 'alert' : 'ok',
      headline:
        allDownTogether === null
          ? '판정된 대장주가 적어 분위기를 볼 수 없습니다'
          : allDownTogether
            ? 'AI 대장주가 거의 다 하락 단계입니다'
            : 'AI 대장주가 다 같이 무너지지는 않았습니다',
      detail:
        allDownTogether === null
          ? `판정된 대장주 ${evaluatedStages.length}개 (4개 이상이어야 판단합니다)`
          : `대장주 ${evaluatedStages.length}개 중 ${aStageCount}개가 하락 단계 (거의 전부면 경고)`,
    },
  ]
}

/**
 * 미국 10년물 금리가 지금 수준이면 무슨 뜻인지 한 줄로 옮긴다.
 *
 * 숫자만 보면 "5.02%"가 높은 건지 낮은 건지 알 수 없다. 구간은 넓게 잡아 몇 년은
 * 안 틀리게 뒀다 — 2020년엔 0.5%, 2023~2026년은 4~5%대였다. 이건 **금리 자체의
 * 좋고 나쁨이 아니라 이 ETF(미국 AI 성장주 묶음)에 어떤 쪽으로 작용하는지**를 말한다.
 */
export function describeTenYearYield(pct: number): { level: string; meaning: string } {
  if (pct >= 4.5) {
    return {
      level: '높은 편',
      meaning:
        '은행·국채에 넣어도 이만큼 주니 굳이 위험을 질 이유가 줄어, AI 같은 성장주에서 돈이 빠져나가기 쉬운 구간입니다.',
    }
  }
  if (pct >= 3) {
    return {
      level: '보통',
      meaning: '성장주에 특별히 불리하지도, 유리하지도 않은 구간입니다.',
    }
  }
  return {
    level: '낮은 편',
    meaning: '안전하게 받을 이자가 적으니, 위험을 지고 성장주로 돈이 몰리기 쉬운 구간입니다.',
  }
}

export interface StopVerdict {
  /** stop = 멈출 신호가 실제로 켜짐 / clear = 멈출 이유 없음 */
  level: 'stop' | 'clear'
  headline: string
  detail: string
}

/**
 * 자동 점검 결과를 한 줄 결론으로 합친다. 항목을 하나씩 다 읽고 머릿속에서 합치게
 * 두지 않기 위한 것이다 — 화면 맨 위에 이 결론을 먼저 보여준다.
 */
export function summarizeStopSignals(signals: StopSignal[]): StopVerdict {
  const alerts = signals.filter((s) => s.state === 'alert')
  const unknowns = signals.filter((s) => s.state === 'unknown')

  if (alerts.length > 0) {
    return {
      level: 'stop',
      headline: '지금은 추가 매수를 멈출 때입니다',
      detail: `자동으로 보는 ${signals.length}가지 중 ${alerts.length}가지에서 위험 신호가 나왔습니다: ${alerts
        .map((a) => a.headline)
        .join(' / ')}`,
    }
  }

  return {
    level: 'clear',
    headline: '지금은 멈출 이유가 없습니다',
    detail:
      unknowns.length > 0
        ? `자동으로 보는 ${signals.length}가지 중 ${signals.length - unknowns.length}가지가 이상 없고, ${unknowns.length}가지는 데이터가 모자라 아직 못 봤습니다.`
        : `자동으로 보는 ${signals.length}가지 모두 이상 없습니다. 다만 아래 2가지는 뉴스를 보고 직접 확인하세요.`,
  }
}
