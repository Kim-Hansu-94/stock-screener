// "포지션 관리" 카드의 지지 신호 점검 — 이미 보유 중인 종목에 추가 매수(물타기)를
// 고민할 때, "지금 지지 신호가 몇 개나 겹쳐 있는지"를 숫자로 보여주기 위한 계산.
//
// 매집 감시(watchlist.py의 evaluate_watch — 박스 수축·조정폭·신저가 진정)와는
// 목적이 다르다. 그쪽은 "아직 안 산 종목이 조용히 매집 구간에 들어왔는가"를 보는
// 반면, 여기는 "이미 큰 포지션을 들고 있는 종목이 지금 지지선 근처인가"를 본다.
// 그래서 박스 수축(조용히 횡보 중일 것)을 요구하지 않는다 — 변동성이 큰 대형주는
// 그 조건에 구조적으로 영원히 걸리지 않기 때문이다(SK하이닉스 사례, 2026-09-06).
//
// **이 점검은 매수 신호가 아니다.** 조건이 다 겹쳐도 더 떨어질 수 있고, 하나도
// 안 겹쳐도 반등할 수 있다. 그래서 단일 "매수 등급"으로 합치지 않고(buySignal.ts의
// buyGrade와 다른 점) 조건별 충족 여부와 실제 숫자를 그대로 나열만 한다 —
// 판단 근거를 숨기지 않고 사용자가 직접 보게 하려는 것이다.

import { ichimokuLines, relativeStrengthIndex, simpleMovingAverage } from './calculations'
import type { PriceHistoryRow } from './types'

/** 장기 추세선 — 감시 종목 차트에 이미 그리고 있는 120일선과 같은 값을 쓴다. */
export const MA_WINDOW = 120
/** 120일선에 이만큼(%) 안쪽이면 "근접"으로 본다. */
export const MA_NEAR_PCT = 5
export const RSI_WINDOW = 14
/**
 * 이 값 이하를 찍었으면 과매도 구간에 들어갔던 것으로 본다.
 *
 * 교과서 기준은 30이지만 35로 완화했다(2026-09-06, 사용자 요청) — 대형주는
 * 지수·수급에 눌려도 RSI가 30까지 잘 안 내려가서, 30을 고수하면 실제로는 충분히
 * 과매도인 구간을 계속 놓친다. SK하이닉스가 최근 14일 최저 43이었던 것이 그 예다.
 */
export const RSI_OVERSOLD = 35
/** 과매도 기록을 찾는 창 (거래일). */
export const RSI_LOOKBACK = 14
/** 저점 높이기 비교 창 — 최근 20일 저점 vs 직전 20일 저점. */
export const LOW_WINDOW = 20
export const VOLUME_RECENT_WINDOW = 5
export const VOLUME_BASE_WINDOW = 20
/**
 * 일목구름 선행 이동 — 선행스팬은 26봉 앞으로 그려지므로, 오늘 가격을 받치는
 * 구름은 26봉 전에 계산된 값이다. 이 보정을 빼면 아직 오지 않은 미래 구름과
 * 오늘 가격을 비교하게 된다(StockChart가 화면에 그릴 때 쓰는 이동과 같은 값).
 */
export const ICHIMOKU_SHIFT = 26

export type SupportSignalId = 'nearMa' | 'cloud' | 'rsiBounce' | 'higherLow' | 'volumeRise'

export interface SupportSignal {
  id: SupportSignalId
  label: string
  /** null = 일봉이 모자라 판정 불가 (충족/미충족 어느 쪽도 아님) */
  met: boolean | null
  /** 충족 여부와 별개로 "지금 얼마나 가까운지"를 보여주는 실제 숫자 */
  detail: string
  /**
   * 코멘트 문장에 끼워 넣을 짧은 구절 (예: "120일선에 근접(-2.6%)").
   * detail 문자열을 다시 파싱하지 않도록 계산한 자리에서 같이 만든다.
   */
  phrase: string
}

export interface SupportSignalAssessment {
  signals: SupportSignal[]
  metCount: number
  /** 데이터가 있어 실제로 판정된 조건 수 — "N/M 충족"의 분모 */
  evaluatedCount: number
}

const INSUFFICIENT = '일봉 데이터 부족'

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const signed = (pct: number) => `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
const price = (value: number) => Math.round(value).toLocaleString('ko-KR')

function nearMaSignal(closes: number[]): SupportSignal {
  const label = `${MA_WINDOW}일선 근접`
  const ma = simpleMovingAverage(closes, MA_WINDOW)
  const maNow = ma[ma.length - 1]
  if (maNow === null || maNow === 0) {
    return { id: 'nearMa', label, met: null, detail: INSUFFICIENT, phrase: '' }
  }

  const gapPct = ((closes[closes.length - 1] - maNow) / maNow) * 100
  const met = Math.abs(gapPct) <= MA_NEAR_PCT
  return {
    id: 'nearMa',
    label,
    met,
    detail: `${MA_WINDOW}일선 대비 ${signed(gapPct)} (기준 ±${MA_NEAR_PCT}%)`,
    phrase: met
      ? `${MA_WINDOW}일선에 근접(${signed(gapPct)})`
      : `${MA_WINDOW}일선보다 ${Math.abs(gapPct).toFixed(1)}% ${gapPct < 0 ? '아래' : '위'}`,
  }
}

function cloudSignal(bars: PriceHistoryRow[]): SupportSignal {
  const label = '일목구름 지지'
  const { senkouA, senkouB } = ichimokuLines(bars.map((b) => b.high), bars.map((b) => b.low))
  // 오늘 캔들 자리에 그려지는 구름 = 26봉 전에 계산된 선행스팬.
  const at = bars.length - 1 - ICHIMOKU_SHIFT
  const a = at >= 0 ? senkouA[at] : null
  const b = at >= 0 ? senkouB[at] : null
  if (a === null || b === null) {
    return { id: 'cloud', label, met: null, detail: INSUFFICIENT, phrase: '' }
  }

  const top = Math.max(a, b)
  const bottom = Math.min(a, b)
  const close = bars[bars.length - 1].close
  if (close >= top) {
    return {
      id: 'cloud', label, met: true,
      detail: `구름 위 (상단 대비 ${signed(((close - top) / top) * 100)})`,
      phrase: '일목구름 위',
    }
  }
  if (close >= bottom) {
    return {
      id: 'cloud', label, met: true,
      detail: `구름 안 (하단 대비 ${signed(((close - bottom) / bottom) * 100)})`,
      phrase: '일목구름 안',
    }
  }
  const belowPct = ((close - bottom) / bottom) * 100
  return {
    id: 'cloud',
    label,
    met: false,
    detail: `구름 아래로 이탈 (하단 대비 ${signed(belowPct)})`,
    phrase: `일목구름보다 ${Math.abs(belowPct).toFixed(1)}% 아래`,
  }
}

function rsiBounceSignal(closes: number[]): SupportSignal {
  const label = 'RSI 과매도 후 반등'
  const rsi = relativeStrengthIndex(closes, RSI_WINDOW)
  const now = rsi[rsi.length - 1]
  const window = rsi.slice(-RSI_LOOKBACK).filter((v): v is number => v !== null)
  if (now === null || window.length < RSI_LOOKBACK) {
    return { id: 'rsiBounce', label, met: null, detail: INSUFFICIENT, phrase: '' }
  }

  const lowest = Math.min(...window)
  // 과매도를 찍은 적이 있고(매도 소진), 지금은 그 바닥보다 올라와 있어야(방향 전환 시도) 한다.
  const wasOversold = lowest <= RSI_OVERSOLD
  const met = wasOversold && now > lowest
  return {
    id: 'rsiBounce',
    label,
    met,
    detail: `RSI ${now.toFixed(0)} · 최근 ${RSI_LOOKBACK}일 최저 ${lowest.toFixed(0)} (기준 ${RSI_OVERSOLD} 이하)`,
    // 미충족이라도 이유가 둘로 갈린다 — 과매도까지 안 간 것과, 과매도에서 아직 못 올라온 것.
    phrase: met
      ? `RSI가 과매도(${lowest.toFixed(0)})를 찍고 ${now.toFixed(0)}까지 반등`
      : wasOversold
        ? `RSI ${now.toFixed(0)}로 과매도에서 아직 반등 못 함`
        : `RSI ${now.toFixed(0)}로 과매도(${RSI_OVERSOLD} 이하)까지는 안 감`,
  }
}

function higherLowSignal(lows: number[]): SupportSignal {
  const label = '저점 높이기'
  if (lows.length < LOW_WINDOW * 2) {
    return { id: 'higherLow', label, met: null, detail: INSUFFICIENT, phrase: '' }
  }

  const recent = Math.min(...lows.slice(-LOW_WINDOW))
  const prior = Math.min(...lows.slice(-LOW_WINDOW * 2, -LOW_WINDOW))
  const met = recent > prior
  return {
    id: 'higherLow',
    label,
    met,
    detail: `최근 ${LOW_WINDOW}일 저점 ${price(recent)} / 직전 ${LOW_WINDOW}일 ${price(prior)}`,
    phrase: met ? '저점이 높아지는 중' : '저점이 계속 낮아지는 중',
  }
}

function volumeRiseSignal(bars: PriceHistoryRow[]): SupportSignal {
  const label = '거래량 실린 상승'
  const needed = VOLUME_RECENT_WINDOW + VOLUME_BASE_WINDOW
  if (bars.length < needed + 1) {
    return { id: 'volumeRise', label, met: null, detail: INSUFFICIENT, phrase: '' }
  }

  const volumes = bars.map((b) => b.volume)
  const recentVol = mean(volumes.slice(-VOLUME_RECENT_WINDOW))
  const baseVol = mean(volumes.slice(-needed, -VOLUME_RECENT_WINDOW))
  const closes = bars.map((b) => b.close)
  const changePct =
    ((closes[closes.length - 1] - closes[closes.length - 1 - VOLUME_RECENT_WINDOW]) /
      closes[closes.length - 1 - VOLUME_RECENT_WINDOW]) *
    100
  if (baseVol <= 0) return { id: 'volumeRise', label, met: null, detail: INSUFFICIENT, phrase: '' }

  const ratio = recentVol / baseVol
  // 거래량만 늘고 가격이 빠지면 오히려 투매다 — 둘을 함께 요구한다.
  const met = ratio > 1 && changePct > 0
  return {
    id: 'volumeRise',
    label,
    met,
    detail: `최근 ${VOLUME_RECENT_WINDOW}일 거래량 ${ratio.toFixed(1)}배 · 주가 ${signed(changePct)}`,
    phrase: met
      ? `거래량 ${ratio.toFixed(1)}배로 늘며 주가 ${signed(changePct)}`
      : ratio <= 1
        ? `거래량이 ${ratio.toFixed(1)}배에 그쳐 매수세 유입 흔적 없음`
        : `거래량은 늘었지만 주가는 ${signed(changePct)}`,
  }
}

/**
 * 일봉을 받아 5개 지지 신호를 각각 판정한다. 오름차순(과거 → 최신) 정렬 전제.
 */
export function assessSupportSignals(bars: PriceHistoryRow[]): SupportSignalAssessment {
  if (bars.length === 0) {
    return { signals: [], metCount: 0, evaluatedCount: 0 }
  }

  const closes = bars.map((b) => b.close)
  const signals: SupportSignal[] = [
    nearMaSignal(closes),
    cloudSignal(bars),
    rsiBounceSignal(closes),
    higherLowSignal(bars.map((b) => b.low)),
    volumeRiseSignal(bars),
  ]

  return {
    signals,
    metCount: signals.filter((s) => s.met === true).length,
    evaluatedCount: signals.filter((s) => s.met !== null).length,
  }
}

// ── 코멘트 자동 생성 ────────────────────────────────────────────────────
// 5개 조건의 충족 여부를 사람이 읽는 문장으로 바꾼다. 카드에 조건별 ✓/✗와
// 숫자는 이미 다 나오지만, "그래서 지금 어떤 그림인가"는 사용자가 매번 다섯 줄을
// 머릿속에서 합쳐야 알 수 있었다 — 그 합치는 일을 대신한다.
//
// **이 코멘트는 매일 AI가 새로 판단하는 게 아니라 아래 규칙이 그대로 도는 것이다.**
// 사이트는 Supabase에서 값만 읽어 그리는 정적 앱이라 판단하는 주체가 없다.
// 규칙이라 항상 같은 입력에 같은 문장이 나오고, 그래서 검증도 가능하다.

/** 지지(바닥이 받쳐주는가) 계열 — 하방이 단단한지를 본다. */
const SUPPORT_IDS: SupportSignalId[] = ['nearMa', 'cloud', 'higherLow']
/** 수요(올라갈 힘이 있는가) 계열 — 매수세가 실제로 들어오는지를 본다. */
const DEMAND_IDS: SupportSignalId[] = ['rsiBounce', 'volumeRise']

export interface SupportSummary {
  /** 카드에 그대로 띄우는 한 문단 */
  text: string
  /** 지지·수요 조합으로 고른 한 줄 결론 (text의 마지막 문장과 같다) */
  verdict: string
}

function verdictFor(supportStrong: boolean, demandStrong: boolean): string {
  if (supportStrong && demandStrong) {
    return '바닥이 받쳐주는 데다 매수세도 들어오는 중이라, 5개 조건 중에서는 가장 좋은 조합입니다.'
  }
  if (supportStrong) {
    return '바닥은 다지는 듯하지만 아직 올라갈 힘은 안 보이는 그림입니다.'
  }
  if (demandStrong) {
    return '지지선 위로는 아직 못 올라왔지만, 단기 반등 조짐은 보이는 그림입니다.'
  }
  return '지지선 아래인 데다 매수세도 없어, 아직 하락이 진행 중일 수 있는 그림입니다.'
}

/**
 * 5개 조건 판정을 한 문단 코멘트로 정리한다. 판정된 조건이 하나도 없으면 null.
 */
export function summarizeSupportSignals(assessment: SupportSignalAssessment): SupportSummary | null {
  const judged = assessment.signals.filter((s) => s.met !== null && s.phrase)
  if (judged.length === 0) return null

  const met = judged.filter((s) => s.met)
  const unmet = judged.filter((s) => !s.met)

  // 계열별로 "판정된 것 중 몇 개가 충족인지"를 본다 — 데이터 부족으로 판정 못 한
  // 조건까지 미충족으로 세면 실제보다 비관적으로 나온다.
  const countMet = (ids: SupportSignalId[]) => met.filter((s) => ids.includes(s.id)).length
  const countJudged = (ids: SupportSignalId[]) => judged.filter((s) => ids.includes(s.id)).length
  // 지지 계열은 과반, 수요 계열은 하나라도 충족이면 "있다"로 본다(수요 조건은 2개뿐이라
  // 과반을 요구하면 사실상 둘 다여야 해서 너무 빡빡하다).
  const supportStrong = countMet(SUPPORT_IDS) * 2 >= countJudged(SUPPORT_IDS) && countMet(SUPPORT_IDS) > 0
  const demandStrong = countMet(DEMAND_IDS) > 0

  const verdict = verdictFor(supportStrong, demandStrong)
  const parts: string[] = []
  if (met.length > 0) parts.push(`지금은 ${met.map((s) => s.phrase).join(', ')}입니다.`)
  if (unmet.length > 0) {
    parts.push(`${met.length > 0 ? '다만 ' : ''}${unmet.map((s) => s.phrase).join(', ')}입니다.`)
  }
  parts.push(verdict)

  return { text: parts.join(' '), verdict }
}

/** 평단가 대비 현재 손익률(%). 평단가가 없거나 0이면 null. */
export function profitLossPct(avgCost: number | null | undefined, currentClose: number): number | null {
  if (avgCost == null || avgCost <= 0) return null
  return ((currentClose - avgCost) / avgCost) * 100
}

/** 보유 이력 구간의 최고가 대비 현재 하락률(%) — 얼마나 깊이 조정 중인지 참고용. */
export function drawdownFromHigh(bars: PriceHistoryRow[]): number | null {
  if (bars.length === 0) return null
  const high = Math.max(...bars.map((b) => b.high))
  if (high <= 0) return null
  return ((bars[bars.length - 1].close - high) / high) * 100
}
