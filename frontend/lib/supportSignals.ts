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
  if (maNow === null || maNow === 0) return { id: 'nearMa', label, met: null, detail: INSUFFICIENT }

  const gapPct = ((closes[closes.length - 1] - maNow) / maNow) * 100
  return {
    id: 'nearMa',
    label,
    met: Math.abs(gapPct) <= MA_NEAR_PCT,
    detail: `${MA_WINDOW}일선 대비 ${signed(gapPct)} (기준 ±${MA_NEAR_PCT}%)`,
  }
}

function cloudSignal(bars: PriceHistoryRow[]): SupportSignal {
  const label = '일목구름 지지'
  const { senkouA, senkouB } = ichimokuLines(bars.map((b) => b.high), bars.map((b) => b.low))
  // 오늘 캔들 자리에 그려지는 구름 = 26봉 전에 계산된 선행스팬.
  const at = bars.length - 1 - ICHIMOKU_SHIFT
  const a = at >= 0 ? senkouA[at] : null
  const b = at >= 0 ? senkouB[at] : null
  if (a === null || b === null) return { id: 'cloud', label, met: null, detail: INSUFFICIENT }

  const top = Math.max(a, b)
  const bottom = Math.min(a, b)
  const close = bars[bars.length - 1].close
  if (close >= top) {
    return { id: 'cloud', label, met: true, detail: `구름 위 (상단 대비 ${signed(((close - top) / top) * 100)})` }
  }
  if (close >= bottom) {
    return { id: 'cloud', label, met: true, detail: `구름 안 (하단 대비 ${signed(((close - bottom) / bottom) * 100)})` }
  }
  return {
    id: 'cloud',
    label,
    met: false,
    detail: `구름 아래로 이탈 (하단 대비 ${signed(((close - bottom) / bottom) * 100)})`,
  }
}

function rsiBounceSignal(closes: number[]): SupportSignal {
  const label = 'RSI 과매도 후 반등'
  const rsi = relativeStrengthIndex(closes, RSI_WINDOW)
  const now = rsi[rsi.length - 1]
  const window = rsi.slice(-RSI_LOOKBACK).filter((v): v is number => v !== null)
  if (now === null || window.length < RSI_LOOKBACK) {
    return { id: 'rsiBounce', label, met: null, detail: INSUFFICIENT }
  }

  const lowest = Math.min(...window)
  return {
    id: 'rsiBounce',
    label,
    // 과매도를 찍은 적이 있고(매도 소진), 지금은 그 바닥보다 올라와 있어야(방향 전환 시도) 한다.
    met: lowest <= RSI_OVERSOLD && now > lowest,
    detail: `RSI ${now.toFixed(0)} · 최근 ${RSI_LOOKBACK}일 최저 ${lowest.toFixed(0)} (기준 ${RSI_OVERSOLD} 이하)`,
  }
}

function higherLowSignal(lows: number[]): SupportSignal {
  const label = '저점 높이기'
  if (lows.length < LOW_WINDOW * 2) return { id: 'higherLow', label, met: null, detail: INSUFFICIENT }

  const recent = Math.min(...lows.slice(-LOW_WINDOW))
  const prior = Math.min(...lows.slice(-LOW_WINDOW * 2, -LOW_WINDOW))
  return {
    id: 'higherLow',
    label,
    met: recent > prior,
    detail: `최근 ${LOW_WINDOW}일 저점 ${price(recent)} / 직전 ${LOW_WINDOW}일 ${price(prior)}`,
  }
}

function volumeRiseSignal(bars: PriceHistoryRow[]): SupportSignal {
  const label = '거래량 실린 상승'
  const needed = VOLUME_RECENT_WINDOW + VOLUME_BASE_WINDOW
  if (bars.length < needed + 1) return { id: 'volumeRise', label, met: null, detail: INSUFFICIENT }

  const volumes = bars.map((b) => b.volume)
  const recentVol = mean(volumes.slice(-VOLUME_RECENT_WINDOW))
  const baseVol = mean(volumes.slice(-needed, -VOLUME_RECENT_WINDOW))
  const closes = bars.map((b) => b.close)
  const changePct =
    ((closes[closes.length - 1] - closes[closes.length - 1 - VOLUME_RECENT_WINDOW]) /
      closes[closes.length - 1 - VOLUME_RECENT_WINDOW]) *
    100
  if (baseVol <= 0) return { id: 'volumeRise', label, met: null, detail: INSUFFICIENT }

  return {
    id: 'volumeRise',
    label,
    // 거래량만 늘고 가격이 빠지면 오히려 투매다 — 둘을 함께 요구한다.
    met: recentVol > baseVol && changePct > 0,
    detail: `최근 ${VOLUME_RECENT_WINDOW}일 거래량 ${(recentVol / baseVol).toFixed(1)}배 · 주가 ${signed(changePct)}`,
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
