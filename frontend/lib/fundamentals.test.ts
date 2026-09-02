import { describe, expect, it } from 'vitest'
import { assessEarnings, assessFinancialHealth } from './fundamentals'
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
    current_assets: null,
    current_liabilities: null,
    total_liabilities: null,
    total_equity: null,
    ...over,
  }
}

describe('assessEarnings', () => {
  it('flags a value trap when revenue and operating income both fell hard', () => {
    const result = assessEarnings(row({ revenue_latest: 70, operating_income_latest: 5 }))
    expect(result.verdict).toBe('deteriorating')
    expect(result.revenueChange).toBeCloseTo(-30, 5)
    expect(result.profitChange).toBeCloseTo(-50, 5)
    expect(result.profitSource).toBe('operating')
  })

  it('calls it a valuation reset when earnings held up', () => {
    expect(assessEarnings(row({ revenue_latest: 104, operating_income_latest: 11 })).verdict).toBe('resilient')
  })

  it('treats a current-year operating loss as the most severe verdict', () => {
    // 매출이 늘었더라도 영업적자면 적자 판정이 우선한다.
    expect(assessEarnings(row({ revenue_latest: 130, operating_income_latest: -3 })).verdict).toBe('loss')
  })

  it('reports mixed when only one side deteriorated', () => {
    expect(assessEarnings(row({ revenue_latest: 98, operating_income_latest: 6 })).verdict).toBe('mixed')
  })

  it('measures change against the magnitude of a prior operating loss', () => {
    // 직전이 -10 적자에서 +5 흑자면 개선인데, 부호 그대로 나누면 음수가 되어 뒤집힌다.
    const result = assessEarnings(row({ operating_income_prior: -10, operating_income_latest: 5 }))
    expect(result.profitChange).toBeCloseTo(150, 5)
  })

  it('returns unknown without data', () => {
    expect(assessEarnings(null).verdict).toBe('unknown')
    expect(
      assessEarnings(row({
        revenue_latest: null, revenue_prior: null,
        operating_income_latest: null, operating_income_prior: null,
        net_income_latest: null, net_income_prior: null,
      })).verdict,
    ).toBe('unknown')
  })

  // ── 영업이익 기준 전환 (개선안 5번) ─────────────────────────────────
  // 한국전력 2015년 사례: 본사 부지 매각으로 당기순이익만 폭증. 순이익 기준으로
  // 판정하면 이런 종목이 '실적 유지'로 잘못 보인다 — 영업이익 기준이라야 걸러진다.
  it('uses operating income, not net income, so an asset-sale spike does not read as resilient', () => {
    const result = assessEarnings(row({
      revenue_latest: 90, revenue_prior: 100,
      operating_income_latest: 6, operating_income_prior: 10, // 영업이익은 -40%
      net_income_latest: 20, net_income_prior: 8, // 당기순이익은 폭증(일회성 매각)
    }))
    expect(result.profitSource).toBe('operating')
    expect(result.profitChange).toBeCloseTo(-40, 5)
    expect(result.verdict).not.toBe('resilient')
  })

  it('falls back to net income when operating income data is missing', () => {
    const result = assessEarnings(row({
      operating_income_latest: null, operating_income_prior: null,
      net_income_latest: 5, net_income_prior: 10,
    }))
    expect(result.profitSource).toBe('net')
    expect(result.profitChange).toBeCloseTo(-50, 5)
  })

  it('flags a one-time gain when net income diverges sharply from operating income', () => {
    // 영업이익 10, 당기순이익 20 → 괴리 100% > 임계값 30%
    const result = assessEarnings(row({ operating_income_latest: 10, net_income_latest: 20 }))
    expect(result.oneTimeGainFlag).toBe(true)
  })

  it('does not flag a one-time gain when net and operating income are close', () => {
    const result = assessEarnings(row({ operating_income_latest: 10, net_income_latest: 11 }))
    expect(result.oneTimeGainFlag).toBe(false)
  })

  it('does not flag a one-time gain when operating income data is missing', () => {
    // 괴리를 잴 기준 자체가 없으므로 과다 경보를 내지 않는다.
    const result = assessEarnings(row({ operating_income_latest: null, net_income_latest: 999 }))
    expect(result.oneTimeGainFlag).toBe(false)
  })
})

describe('assessFinancialHealth', () => {
  it('returns unknown with no row', () => {
    expect(assessFinancialHealth(null).verdict).toBe('unknown')
    expect(assessFinancialHealth(undefined).verdict).toBe('unknown')
  })

  it('returns unknown when current assets/liabilities are missing (e.g. US rows today)', () => {
    const result = assessFinancialHealth(row({ current_assets: null, current_liabilities: null }))
    expect(result.verdict).toBe('unknown')
    expect(result.currentRatio).toBeNull()
  })

  it('calls it healthy when current ratio is 2.0 or above (책 기준: 일반 제조업체 양호)', () => {
    const result = assessFinancialHealth(row({ current_assets: 500, current_liabilities: 200 }))
    expect(result.currentRatio).toBeCloseTo(2.5, 5)
    expect(result.verdict).toBe('healthy')
  })

  it('calls it weak when current ratio is between 1.0 and 2.0', () => {
    const result = assessFinancialHealth(row({ current_assets: 300, current_liabilities: 200 }))
    expect(result.currentRatio).toBeCloseTo(1.5, 5)
    expect(result.verdict).toBe('weak')
  })

  it('calls it fragile when current ratio is under 1.0 (책 기준: 가까스로 지급책임 이행하는 경계 아래)', () => {
    const result = assessFinancialHealth(row({ current_assets: 150, current_liabilities: 200 }))
    expect(result.currentRatio).toBeCloseTo(0.75, 5)
    expect(result.verdict).toBe('fragile')
  })

  it('reports debt-to-equity as a plain figure without folding it into the verdict', () => {
    // 부채비율은 책이 "업종별로 완전히 다르다"고 경고한 지표라 verdict에 안 섞는다 —
    // 유동비율이 양호해도(healthy) 부채비율 수치는 그대로 계산해서 보여준다.
    const result = assessFinancialHealth(row({
      current_assets: 500, current_liabilities: 200,
      total_liabilities: 600, total_equity: 300,
    }))
    expect(result.verdict).toBe('healthy')
    expect(result.debtToEquity).toBeCloseTo(2.0, 5)
  })

  it('leaves debt-to-equity null when equity data is missing', () => {
    const result = assessFinancialHealth(row({
      current_assets: 500, current_liabilities: 200,
      total_liabilities: 600, total_equity: null,
    }))
    expect(result.debtToEquity).toBeNull()
  })
})
