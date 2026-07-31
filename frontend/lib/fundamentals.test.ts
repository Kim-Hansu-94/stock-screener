import { describe, expect, it } from 'vitest'
import { assessEarnings } from './fundamentals'
import type { FundamentalsRow } from './types'

function row(over: Partial<FundamentalsRow>): FundamentalsRow {
  return {
    ticker: 'IFF',
    market: 'US',
    updated_at: '2026-07-31',
    fiscal_year_latest: 2025,
    fiscal_year_prior: 2022,
    revenue_latest: 100,
    revenue_prior: 100,
    operating_income_latest: 10,
    operating_income_prior: 10,
    net_income_latest: 10,
    net_income_prior: 10,
    eps_latest: 1,
    eps_prior: 1,
    per: 15,
    pbr: 1.2,
    ...over,
  }
}

describe('assessEarnings', () => {
  it('flags a value trap when revenue and profit both fell hard', () => {
    const result = assessEarnings(row({ revenue_latest: 70, net_income_latest: 5 }))
    expect(result.verdict).toBe('deteriorating')
    expect(result.revenueChange).toBeCloseTo(-30, 5)
    expect(result.profitChange).toBeCloseTo(-50, 5)
  })

  it('calls it a valuation reset when earnings held up', () => {
    expect(assessEarnings(row({ revenue_latest: 104, net_income_latest: 11 })).verdict).toBe('resilient')
  })

  it('treats a current-year loss as the most severe verdict', () => {
    // 매출이 늘었더라도 적자면 적자 판정이 우선한다.
    expect(assessEarnings(row({ revenue_latest: 130, net_income_latest: -3 })).verdict).toBe('loss')
  })

  it('reports mixed when only one side deteriorated', () => {
    expect(assessEarnings(row({ revenue_latest: 98, net_income_latest: 6 })).verdict).toBe('mixed')
  })

  it('measures change against the magnitude of a prior loss', () => {
    // 직전이 -10 적자에서 +5 흑자면 개선인데, 부호 그대로 나누면 음수가 되어 뒤집힌다.
    const result = assessEarnings(row({ net_income_prior: -10, net_income_latest: 5 }))
    expect(result.profitChange).toBeCloseTo(150, 5)
  })

  it('returns unknown without data', () => {
    expect(assessEarnings(null).verdict).toBe('unknown')
    expect(
      assessEarnings(row({ revenue_latest: null, revenue_prior: null, net_income_latest: null, net_income_prior: null }))
        .verdict,
    ).toBe('unknown')
  })
})
