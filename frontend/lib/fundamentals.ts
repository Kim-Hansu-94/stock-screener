import type { FundamentalsRow } from './types'

// "주가가 빠질 때 실적도 같이 빠졌는가" — 가치 함정과 밸류에이션 조정을 가르는
// 판정. 차트는 둘을 구분하지 못하므로, 점수와 별개로 이 신호를 함께 보여준다.

export type EarningsVerdict =
  | 'loss' // 최신 회계연도 적자
  | 'deteriorating' // 매출·이익이 뚜렷하게 감소
  | 'mixed' // 한쪽만 감소하거나 감소폭이 애매
  | 'resilient' // 실적은 유지·성장 (주가만 하락 = 밸류에이션 조정)
  | 'unknown' // 데이터 부족

/** 매출이 이만큼 넘게 줄면 감소로 본다 (%) */
const REVENUE_DROP = 20
/** 이익이 이만큼 넘게 줄면 감소로 본다 (%) — 이익은 매출보다 변동이 커 기준을 완화 */
const PROFIT_DROP = 30
/** 실적 유지로 인정하는 상한 (%) */
const REVENUE_FLAT = 5
const PROFIT_FLAT = 10

export interface EarningsAssessment {
  verdict: EarningsVerdict
  /** 매출 변화율 % (직전 회계연도 대비) */
  revenueChange: number | null
  /** 순이익 변화율 % */
  profitChange: number | null
  years: { latest: number | null; prior: number | null }
}

function pctChange(latest: number | null, prior: number | null): number | null {
  if (latest === null || prior === null || prior === 0) return null
  // 직전이 적자면 변화율이 부호가 뒤집혀 의미를 잃으므로 절댓값을 분모로 쓴다.
  return ((latest - prior) / Math.abs(prior)) * 100
}

export function assessEarnings(row: FundamentalsRow | null | undefined): EarningsAssessment {
  if (!row) {
    return { verdict: 'unknown', revenueChange: null, profitChange: null, years: { latest: null, prior: null } }
  }

  const revenueChange = pctChange(row.revenue_latest, row.revenue_prior)
  const profitChange = pctChange(row.net_income_latest, row.net_income_prior)
  const years = { latest: row.fiscal_year_latest, prior: row.fiscal_year_prior }

  if (row.net_income_latest !== null && row.net_income_latest < 0) {
    return { verdict: 'loss', revenueChange, profitChange, years }
  }
  if (revenueChange === null && profitChange === null) {
    return { verdict: 'unknown', revenueChange, profitChange, years }
  }

  const revenueDown = revenueChange !== null && revenueChange <= -REVENUE_DROP
  const profitDown = profitChange !== null && profitChange <= -PROFIT_DROP
  if (revenueDown && profitDown) {
    return { verdict: 'deteriorating', revenueChange, profitChange, years }
  }

  const revenueHeld = revenueChange === null || revenueChange >= -REVENUE_FLAT
  const profitHeld = profitChange === null || profitChange >= -PROFIT_FLAT
  if (revenueHeld && profitHeld) {
    return { verdict: 'resilient', revenueChange, profitChange, years }
  }

  return { verdict: 'mixed', revenueChange, profitChange, years }
}

export const EARNINGS_LABEL: Record<EarningsVerdict, string> = {
  loss: '🚨 적자 전환',
  deteriorating: '⚠️ 실적 동반 하락',
  mixed: '실적 혼조',
  resilient: '실적 유지 · 밸류에이션 조정',
  unknown: '실적 데이터 없음',
}

// 실적 판정은 등락(가격 방향)이 아니라 좋음/나쁨이라 등락 색과 구분한다.
// 나쁨은 destructive, 좋음은 브랜드 블루, 경고는 앰버(방향과 무관한 주의색)로 둔다.
export const EARNINGS_CLASS: Record<EarningsVerdict, string> = {
  loss: 'bg-destructive/10 text-destructive',
  deteriorating: 'bg-amber-100 text-amber-800',
  mixed: 'bg-muted text-muted-foreground',
  resilient: 'bg-accent text-accent-foreground',
  unknown: 'bg-muted text-muted-foreground/70',
}

export const EARNINGS_NOTE: Record<EarningsVerdict, string> = {
  loss: '최신 회계연도가 적자입니다. 차트가 바닥처럼 보여도 실적이 먼저 돌아서야 합니다.',
  deteriorating:
    '주가와 함께 매출·이익도 뚜렷하게 줄었습니다. 구조적 문제일 수 있어 가치 함정에 주의하세요.',
  mixed: '매출과 이익의 방향이 엇갈립니다. 원인을 직접 확인해 보세요.',
  resilient:
    '실적은 유지되는데 주가만 하락했습니다. 밸류에이션 조정에 가까워 재평가 여지가 있습니다.',
  unknown: '실적 데이터를 아직 받지 못했습니다. 판단에 참고하지 마세요.',
}
