import type { PriceHistoryRow } from './types'

// 3년 창 밖(예: 2021년 고점)이 조정폭 계산에서 통째로 빠지는 문제를 보완하기 위한
// 장기 맥락 계산. stock_long_monthly(10년, 과거 확정 구간)와 mv_monthly_ohlcv
// (최근 3년, 매일 갱신)를 합쳐 하나의 월봉 시리즈로 만든다.

/** 3년 고점이 장기 고점보다 이 비율 아래면 "장기 하락 추세"로 본다. */
export const LONG_DECLINE_RATIO = 0.8

export interface LongTermContext {
  /** 병합된 월봉 (오래된 순) — 장기 차트용 */
  monthly: PriceHistoryRow[]
  /** 장기 고점 (월봉 고가 기준). 데이터 부족 시 null */
  longTermHigh: number | null
  /** 장기 고점 대비 하락률 % */
  longTermDrawdown: number | null
  /** 3년 고점이 장기 고점보다 크게 낮음 = 이미 여러 해 내려온 종목 */
  longTermDeclining: boolean
  /** 병합 시리즈가 실제로 3년보다 길게 확보됐는지 */
  hasLongHistory: boolean
}

/**
 * 같은 달이 양쪽에 있으면 최근 데이터(recent)를 채택한다 — 과거 시드는 수집
 * 시점 이후 갱신되지 않으므로 진행 중인 달은 recent 쪽이 정확하다.
 */
export function mergeMonthly(
  longRows: PriceHistoryRow[],
  recentRows: PriceHistoryRow[],
): PriceHistoryRow[] {
  const byMonth = new Map<string, PriceHistoryRow>()
  for (const row of longRows) byMonth.set(row.date.slice(0, 7), row)
  for (const row of recentRows) byMonth.set(row.date.slice(0, 7), row)
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => row)
}

export function buildLongTermContext(
  longRows: PriceHistoryRow[],
  recentRows: PriceHistoryRow[],
  currentClose: number,
  high3y: number,
): LongTermContext {
  const monthly = mergeMonthly(longRows, recentRows)
  // 최근 3년치만 있으면(=시드 전) 장기 맥락을 주장하지 않는다. 월봉 40개 ≈ 3년 4개월.
  const hasLongHistory = monthly.length > 40

  if (monthly.length === 0) {
    return { monthly, longTermHigh: null, longTermDrawdown: null, longTermDeclining: false, hasLongHistory: false }
  }

  const longTermHigh = Math.max(...monthly.map((row) => row.high))
  const longTermDrawdown =
    longTermHigh > 0 ? ((longTermHigh - currentClose) / longTermHigh) * 100 : null

  return {
    monthly,
    longTermHigh,
    longTermDrawdown,
    // 3년 고점 자체가 장기 고점보다 한참 낮다 = 3년 창 안에서는 보이지 않는 하락이 있었다
    longTermDeclining:
      hasLongHistory && longTermHigh > 0 && high3y < longTermHigh * LONG_DECLINE_RATIO,
    hasLongHistory,
  }
}
