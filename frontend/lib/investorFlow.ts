import type { InvestorFlowRow } from '@/lib/types'

/**
 * 수급 요약 — 최근 며칠 동안 외국인·기관이 순매수였나 순매도였나.
 *
 * 화면에 일별 막대만 그리면 "그래서 어느 쪽이냐"를 눈으로 세어야 한다. 여기서
 * 누적과 연속 일수를 미리 내서, 카드가 한 줄로 결론을 말할 수 있게 한다.
 *
 * **판정하지 않는다.** "외국인이 사니 좋다" 같은 결론은 내지 않는다 — 수급은
 * 근거의 한 축일 뿐이고, 이 사이트는 값만 읽어 그리는 정적 앱이라 매일 새로
 * 판단하는 주체가 없다(supportSignals.ts와 같은 원칙).
 */

export type FlowSide = 'foreign' | 'institution'

export type FlowSummary = {
  /** 구간 누적 순매매 수량(주) */
  netQty: number
  /** 구간 누적 순매매 금액 */
  netAmount: number
  /** 마지막 날부터 세어 같은 방향이 이어진 일수 (순매수면 양수, 순매도면 음수) */
  streak: number
  /** 구간 중 순매수였던 날 수 */
  buyDays: number
  /** 값이 있는 날 수 — 분모다. 0이면 표시할 게 없다는 뜻. */
  days: number
}

function qtyOf(row: InvestorFlowRow, side: FlowSide): number | null {
  return side === 'foreign' ? row.foreign_net_qty : row.institution_net_qty
}

function amountOf(row: InvestorFlowRow, side: FlowSide): number | null {
  return side === 'foreign' ? row.foreign_net_amount : row.institution_net_amount
}

/**
 * @param rows 날짜 오름차순(과거 → 최근) 행. 쿼리가 그 순서로 준다.
 */
export function summarizeFlow(rows: InvestorFlowRow[], side: FlowSide): FlowSummary {
  let netQty = 0
  let netAmount = 0
  let buyDays = 0
  let days = 0

  for (const row of rows) {
    const qty = qtyOf(row, side)
    if (qty === null) continue
    days += 1
    netQty += qty
    netAmount += amountOf(row, side) ?? 0
    if (qty > 0) buyDays += 1
  }

  // 연속 일수는 최근 날부터 거꾸로 센다. 0인 날(순매매 없음)은 방향을 끊는 것으로
  // 본다 — 안 그러면 거래가 없던 하루를 사이에 두고 "10일 연속 순매수"가 된다.
  let streak = 0
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const qty = qtyOf(rows[i], side)
    if (qty === null || qty === 0) break
    const direction = qty > 0 ? 1 : -1
    if (streak !== 0 && Math.sign(streak) !== direction) break
    streak += direction
  }

  return { netQty, netAmount, streak, buyDays, days }
}

/** 막대그래프의 세로 축 기준 — 양쪽(외국인·기관)에서 가장 큰 절댓값. */
export function flowScale(rows: InvestorFlowRow[]): number {
  let max = 0
  for (const row of rows) {
    for (const qty of [row.foreign_net_qty, row.institution_net_qty]) {
      if (qty !== null) max = Math.max(max, Math.abs(qty))
    }
  }
  return max
}

/** 금액을 "1.2조 / 3,400억 / 5,600만" 처럼 읽기 쉬운 한국식 단위로. */
export function formatKrwCompact(amount: number): string {
  const abs = Math.abs(amount)
  const sign = amount < 0 ? '−' : ''
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(1)}조`
  if (abs >= 1e8) return `${sign}${Math.round(abs / 1e8).toLocaleString('ko-KR')}억`
  if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4).toLocaleString('ko-KR')}만`
  return `${sign}${Math.round(abs).toLocaleString('ko-KR')}`
}
