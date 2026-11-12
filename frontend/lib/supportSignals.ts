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
//
// ── 백테스트로 실제로 재봤다 (2026-11-11) ──────────────────────────────────
// `research/backtestSupportSignals.ts`로 국장 946종목 16,832건(물타기 상황만 보면
// 814종목 7,584건)을 재생해, 조건을 충족한 날과 미충족한 날의 그 뒤 수익률을 비교했다.
// **날짜별 중앙값을 빼 시장 효과를 제거한 값**(이게 진짜 우위다)의 중앙값 차이:
//
//   조건                전체20일  전체60일  물타기20일  물타기60일
//   120일선 근접          +0.26%    +0.52%     +0.30%     +1.20%
//   일목구름 지지         -0.14%    +0.97%     -1.81%     -1.96%
//   RSI 과매도 후 반등    +0.00%    -1.04%     +0.57%     +0.58%
//   저점 높이기           -0.07%    +0.99%     -1.10%     -1.50%
//   거래량 실린 상승      +0.22%    +0.00%     -0.13%     -1.26%
//
// 읽어야 할 세 가지.
//
// **(1) 임계값을 손볼 근거가 없다.** 차이가 전부 ±2% 안이고 **부호가 표본과
// 지평선에 따라 뒤집힌다**(일목구름 +0.97% ↔ -1.96%, 저점 높이기 +0.99% ↔ -1.50%,
// RSI -1.04% ↔ +0.57%). `backtestEtfStage.ts`가 490590에서 얻은 결론과 똑같다 —
// 부호가 안 고정되는 건 구조가 아니라 잡음이거나 상황 의존이라는 뜻이다. 그래서
// 2026-11-11 재검토에서 **조건·임계값은 하나도 바꾸지 않았다**(바꾼 건 문구와
// 일봉 창뿐이다). MA_NEAR_PCT를 비대칭으로 바꾸거나 RSI 반등 강도를 요구하거나
// 거래량에 buyingVolumeShare를 넣는 안을 세워 봤지만, 전부 이 숫자가 받쳐 주지 않는다.
//
// **(2) 깊이 빠진 종목에서는 지지 조건이 오히려 거꾸로다.** 일목구름·저점 높이기는
// 전체 표본 60일에서 +1%쯤인데 물타기 상황에서는 두 지평선 모두 -1.5~-2%다.
// 네 칸 모두 양수인 건 **120일선 근접 하나뿐**이다.
//
// **(3) 개수를 세는 것이 물타기 상황에서는 근거가 없다.** 충족 개수별 60일
// 중앙값(물타기, 시장효과 제거)이 0개 -0.43% · 1개 -1.47% · 2개 -2.57% ·
// 3개 -1.79% · 4개 +0.15%(132건)로 **단조롭지 않고 2개가 최악**이다. 전체 표본에서도
// 0개 -0.17% · 1개 -0.65% · 2개 0.00% · 3개 +0.90% · 4개 +0.07%로 들쭉날쭉하다.
// 그래서 화면은 "N/5 충족"을 **많을수록 좋다는 뜻으로 읽히지 않게** 적어야 한다.
//
// 한계: 생존 편향을 못 뺐고(유니버스가 오늘 기준), 60일 성과를 10일 간격으로 봐서
// 연속한 표본이 서로 겹친다. 믿을 숫자는 건수가 아니라 종목 수다.

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
    detail: `최근 ${VOLUME_RECENT_WINDOW}일 거래량이 직전 ${VOLUME_BASE_WINDOW}일 평균의 ${ratio.toFixed(1)}배 · 주가 ${signed(changePct)}`,
    // 미충족일 때 "매수세 유입 흔적 없음"이라고 단정하지 않는다 (2026-09-23).
    // 이 지표가 재는 건 "거래량이 직전 20일보다 늘었는가" 하나뿐인데, 그 문구는
    // "사는 사람이 없다"로 읽힌다 — 실제로 SK하이닉스는 주가 +5.9%에 자사주를
    // 매일 사들이고 있는 중에도 이 문장이 떴다. 자사주 매입처럼 꾸준히 조금씩
    // 사는 수요는 거래량을 터뜨리지 않기 때문이다.
    // 게다가 이 비율은 1을 넘기가 생각보다 어렵다 — 156일을 재보니 중간값이
    // 0.93이고 61%가 1 이하였다(편향이 없다면 중간값이 1.00이어야 한다).
    // 거래량은 가끔 확 터지는 분포라, 짧은 평균(5일)을 긴 평균(20일)으로 나누면
    // 터진 날 하나를 분모가 오래 물고 있어 대체로 1보다 조금 작게 나온다.
    // 그래서 판정(met)은 그대로 두되 **관측한 사실만** 말한다.
    phrase: met
      ? `거래량 ${ratio.toFixed(1)}배로 늘며 주가 ${signed(changePct)}`
      : ratio <= 1
        ? `거래량은 직전 ${VOLUME_BASE_WINDOW}일 평균의 ${ratio.toFixed(1)}배로 늘지 않음`
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

/**
 * 지지 계열이 **하나도** 충족되지 않은 상태를 따로 가른다.
 *
 * 왜 따로 가르나 (2026-11-11, SK하이닉스 실측으로 드러났다)
 * ---------------------------------------------------------
 * 예전에는 지지 계열을 `supportStrong` 하나(과반인가)로만 봤다. 그래서 지지 3개가
 * **전부** 깨져도 수요 조건 하나만 걸리면 "지지선 위로는 아직 못 올라왔지만, 단기
 * 반등 조짐은 보이는 그림"이라는 결론이 나왔다. 실제로 그렇게 떴다:
 *
 *   120일선 대비 -33.5% · 일목구름 하단 대비 -25.3% · 저점 계속 낮아지는 중 ·
 *   거래량 1.3배인데 주가 -14.1% · 평단 대비 -40.2% · 구간 고점 대비 -59.3%
 *   → 그런데 RSI가 32에서 40으로 올라온 것 하나로 "단기 반등 조짐"
 *
 * 59% 빠지는 중인 종목에서 RSI가 8포인트 올라온 건 하루하루의 잡음이고, 그걸
 * "조짐"이라고 부르면 **물타기를 권하는 것처럼 읽힌다.** 과반(1.5개)과 0개는
 * 질적으로 다른 상태라, 0개를 따로 본다.
 *
 * 문구만 바꾼 것이지 **판정(met)은 건드리지 않았다** — 어느 조건이 충족인지는 그대로다.
 */
type SupportLevel = 'none' | 'partial' | 'strong'

function verdictFor(support: SupportLevel, demandStrong: boolean): string {
  if (support === 'none') {
    // 받쳐 줄 자리가 없을 때는 수요 조건이 걸려도 "조짐"으로 부르지 않는다.
    return demandStrong
      ? '바닥을 받쳐 주는 신호는 하나도 없습니다. 단기 반등 움직임은 있지만 아래를 받쳐 줄 자리가 없어, 아직 하락이 진행 중인 그림으로 보는 편이 안전합니다.'
      : '바닥을 받쳐 주는 신호가 하나도 없고 매수세도 안 보여, 하락이 그대로 진행 중인 그림입니다.'
  }
  if (support === 'strong') {
    return demandStrong
      ? '바닥이 받쳐주는 데다 매수세도 들어오는 중이라, 5개 조건 중에서는 가장 좋은 조합입니다.'
      : '바닥은 다지는 듯하지만 아직 올라갈 힘은 안 보이는 그림입니다.'
  }
  return demandStrong
    ? '지지선 위로는 아직 못 올라왔지만, 단기 반등 조짐은 보이는 그림입니다.'
    : '지지선 아래인 데다 매수세도 없어, 아직 하락이 진행 중일 수 있는 그림입니다.'
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
  // 단 지지 계열이 **0개**면 과반 여부와 별개로 따로 가른다 — verdictFor 주석 참고.
  const supportMet = countMet(SUPPORT_IDS)
  const supportJudged = countJudged(SUPPORT_IDS)
  const support: SupportLevel =
    supportJudged > 0 && supportMet === 0
      ? 'none'
      : supportMet * 2 >= supportJudged && supportMet > 0
        ? 'strong'
        : 'partial'
  const demandStrong = countMet(DEMAND_IDS) > 0

  const verdict = verdictFor(support, demandStrong)
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
