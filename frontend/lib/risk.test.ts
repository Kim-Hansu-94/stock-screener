import { describe, expect, it } from 'vitest'
import { computeStopTarget, filterBarsAsOf, type PriceBar } from './risk'

function dayLabel(n: number): string {
  return `D${String(n).padStart(4, '0')}`
}

function makeUptrendBars(count: number, startClose: number, dailyGain: number): PriceBar[] {
  const bars: PriceBar[] = []
  let close = startClose
  for (let i = 0; i < count; i++) {
    close += dailyGain
    bars.push({ date: dayLabel(i), high: close + 0.5, low: close - 0.5, close })
  }
  return bars
}

describe('filterBarsAsOf', () => {
  it('keeps only bars on or before the cutoff date', () => {
    const bars: PriceBar[] = [
      { date: '2026-06-01', high: 10, low: 9, close: 9.5 },
      { date: '2026-06-29', high: 12, low: 11, close: 11.5 },
      { date: '2026-07-02', high: 20, low: 15, close: 18 },
    ]
    const result = filterBarsAsOf(bars, '2026-06-29')
    expect(result.map((b) => b.date)).toEqual(['2026-06-01', '2026-06-29'])
  })
})

describe('computeStopTarget entry-date bounding regression', () => {
  it('does not let post-entry volatility corrupt the risk-reward ratio', () => {
    // 70 quiet bars building a stable uptrend (>= 65 needed for the SMA60+5 trend
    // check), entry taken on the last of these
    const preEntryBars = makeUptrendBars(70, 100, 1)
    const entryDate = preEntryBars.at(-1)!.date
    const entry = preEntryBars.at(-1)!.close

    const correctResult = computeStopTarget(filterBarsAsOf(preEntryBars, entryDate), entry)

    // Simulate real trading days passing after entry: a sharp rally with much wider
    // daily ranges than the pre-entry period (this is what actually happened with
    // the reported tickers — the stock rallied hard right after being screened).
    const postEntryRally: PriceBar[] = []
    let close = entry
    for (let i = 1; i <= 20; i++) {
      close *= 1.02
      postEntryRally.push({ date: `2026-08-${String(i).padStart(2, '0')}`, high: close * 1.05, low: close * 0.9, close })
    }
    const unboundedBars = [...preEntryBars, ...postEntryRally]

    const buggyResult = computeStopTarget(unboundedBars, entry)

    // The bug: including future bars inflates ATR (from the rally's wide daily ranges),
    // which pushes the stop further from entry and crushes riskReward toward implausibly
    // low values, even though nothing about the entry-day setup changed.
    expect(buggyResult.riskReward).not.toBeCloseTo(correctResult.riskReward ?? NaN, 5)
    expect(correctResult.riskReward).not.toBeNull()
  })
})
