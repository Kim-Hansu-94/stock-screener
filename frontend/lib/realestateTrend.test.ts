import { describe, expect, it } from 'vitest'
import { regionGroup, regionOverview, regionRows, withMomChange } from './realestateTrend'
import type { RealestateMonthlyRow } from './types'

function row(over: Partial<RealestateMonthlyRow>): RealestateMonthlyRow {
  return {
    region_code: '11680',
    region_name: '서울 강남구',
    month: '2026-06-01',
    area_band: 'ALL',
    deal_count: 10,
    price_avg: 200000,
    price_median: 195000,
    price_per_area_avg: 2500,
    jeonse_count: 4,
    deposit_avg: 90000,
    deposit_median: 88000,
    monthly_rent_count: 1,
    jeonse_ratio: 0.45,
    gap_avg: 110000,
    ...over,
  }
}

describe('regionGroup', () => {
  it('groups by the LAWD_CD prefix', () => {
    expect(regionGroup('11680')).toBe('서울')
    expect(regionGroup('28185')).toBe('인천')
    expect(regionGroup('41190')).toBe('경기')
    expect(regionGroup('99999')).toBe('기타')
  })
})

describe('regionOverview', () => {
  it('picks the latest ALL-band month per region and computes MoM change', () => {
    const rows = [
      row({ month: '2026-05-01', price_avg: 200000 }),
      row({ month: '2026-06-01', price_avg: 210000 }),
      row({ region_code: '28185', region_name: '인천 연수구', month: '2026-06-01', price_avg: 100000 }),
    ]
    const overview = regionOverview(rows)
    const gangnam = overview.find((r) => r.region_code === '11680')!
    expect(gangnam.latest.month).toBe('2026-06-01')
    expect(gangnam.momPricePct).toBeCloseTo(5, 5) // 200000 -> 210000

    const yeonsu = overview.find((r) => r.region_code === '28185')!
    expect(yeonsu.prior).toBeNull()
    expect(yeonsu.momPricePct).toBeNull() // 비교할 직전 달이 없다
  })

  it('ignores non-ALL bands', () => {
    const rows = [row({ area_band: '60~85', price_avg: 999999 })]
    expect(regionOverview(rows)).toHaveLength(0)
  })

  it('uses the last month that actually has data as "prior", not strictly last calendar month', () => {
    // 3월엔 거래가 없어 행 자체가 없다 — 5월의 직전은 2월이어야 한다.
    const rows = [
      row({ month: '2026-02-01', price_avg: 180000 }),
      row({ month: '2026-05-01', price_avg: 200000 }),
    ]
    const [trend] = regionOverview(rows)
    expect(trend.prior?.month).toBe('2026-02-01')
    expect(trend.momPricePct).toBeCloseTo(((200000 - 180000) / 180000) * 100, 5)
  })

  it('sorts by latest average sale price, highest first', () => {
    const rows = [
      row({ region_code: '11680', region_name: '서울 강남구', price_avg: 250000 }),
      row({ region_code: '28185', region_name: '인천 연수구', price_avg: 80000 }),
      row({ region_code: '41590', region_name: '화성시', price_avg: 150000 }),
    ]
    const overview = regionOverview(rows)
    expect(overview.map((r) => r.region_code)).toEqual(['11680', '41590', '28185'])
  })

  it('puts regions with no sale price (jeonse/rent only) last', () => {
    const rows = [
      row({ region_code: '11680', region_name: '서울 강남구', price_avg: null, deal_count: 0 }),
      row({ region_code: '28185', region_name: '인천 연수구', price_avg: 80000 }),
    ]
    const overview = regionOverview(rows)
    expect(overview.map((r) => r.region_code)).toEqual(['28185', '11680'])
  })
})

describe('regionRows', () => {
  it('filters to one region across all bands', () => {
    const rows = [
      row({ area_band: 'ALL' }),
      row({ area_band: '60~85' }),
      row({ region_code: '28185', area_band: 'ALL' }),
    ]
    expect(regionRows(rows, '11680')).toHaveLength(2)
  })
})

describe('withMomChange', () => {
  it('sorts newest-first and computes month-over-month change against the previous row', () => {
    const rows = [
      row({ month: '2026-04-01', price_avg: 100000 }),
      row({ month: '2026-06-01', price_avg: 120000 }),
      row({ month: '2026-05-01', price_avg: 110000 }),
    ]
    const result = withMomChange(rows)
    expect(result.map((r) => r.month)).toEqual(['2026-06-01', '2026-05-01', '2026-04-01'])
    expect(result[0].momPricePct).toBeCloseTo(((120000 - 110000) / 110000) * 100, 5)
    expect(result[2].momPricePct).toBeNull() // 가장 오래된 달은 비교 대상이 없다
  })

  it('leaves momPricePct null when either side is missing a price', () => {
    const rows = [row({ month: '2026-05-01', price_avg: null }), row({ month: '2026-06-01', price_avg: 100000 })]
    const result = withMomChange(rows)
    expect(result[0].momPricePct).toBeNull()
  })
})
