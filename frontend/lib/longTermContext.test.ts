import { describe, expect, it } from 'vitest'
import { buildLongTermContext, mergeMonthly } from './longTermContext'
import type { PriceHistoryRow } from './types'

function bar(date: string, close: number, high = close): PriceHistoryRow {
  return { ticker: 'IFF', market: 'US', date, open: close, high, low: close, close, volume: 100 }
}

function series(startYear: number, months: number, high: number): PriceHistoryRow[] {
  const rows: PriceHistoryRow[] = []
  for (let i = 0; i < months; i++) {
    const y = startYear + Math.floor(i / 12)
    const m = String((i % 12) + 1).padStart(2, '0')
    rows.push(bar(`${y}-${m}-01`, high))
  }
  return rows
}

describe('mergeMonthly', () => {
  it('prefers the recent row when both sources cover the same month', () => {
    const merged = mergeMonthly([bar('2026-07-01', 50)], [bar('2026-07-01', 70)])
    expect(merged).toHaveLength(1)
    expect(merged[0].close).toBe(70)
  })

  it('returns a single chronologically sorted series', () => {
    const merged = mergeMonthly([bar('2019-01-01', 10)], [bar('2026-01-01', 20)])
    expect(merged.map((r) => r.date)).toEqual(['2019-01-01', '2026-01-01'])
  })
})

describe('buildLongTermContext', () => {
  it('finds a peak that sits outside the 3-year window', () => {
    // 2018~2021 고점 140 → 3년 창(최근 36개월)에는 105만 남은 IFF 형태
    const old = series(2017, 60, 140)
    const recent = series(2023, 40, 105)
    const ctx = buildLongTermContext(old, recent, 73, 105)

    expect(ctx.longTermHigh).toBe(140)
    // 3년 고점 기준 -30%로 보이던 것이 실제로는 -47.9%
    expect(ctx.longTermDrawdown).toBeCloseTo(47.86, 1)
    expect(ctx.longTermDeclining).toBe(true)
    expect(ctx.hasLongHistory).toBe(true)
  })

  it('does not flag a decline when the 3-year high is near the long-term high', () => {
    const old = series(2017, 60, 100)
    const recent = series(2023, 40, 98)
    const ctx = buildLongTermContext(old, recent, 80, 98)

    expect(ctx.longTermDeclining).toBe(false)
  })

  it('withholds long-term claims when only the recent window is seeded', () => {
    const recent = series(2023, 36, 100)
    const ctx = buildLongTermContext([], recent, 70, 100)

    expect(ctx.hasLongHistory).toBe(false)
    expect(ctx.longTermDeclining).toBe(false)
  })

  it('handles a ticker with no data at all', () => {
    const ctx = buildLongTermContext([], [], 50, 0)
    expect(ctx.longTermHigh).toBeNull()
    expect(ctx.longTermDrawdown).toBeNull()
  })
})
