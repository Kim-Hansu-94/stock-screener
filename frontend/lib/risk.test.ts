import { describe, expect, it } from 'vitest'
import { computeATR, computeStopTarget, filterBarsAsOf, type PriceBar } from './risk'

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

describe('computeStopTarget swing-low buffer', () => {
  it('places the stop below the swing low instead of exactly at it', () => {
    // 60-bar uptrend so the SMA60 trend gate passes.
    const bars = makeUptrendBars(60, 100, 1)
    // Wide-range consolidation: closes hold 160 while lows probe 155, so the swing
    // low sits within one ATR of entry and the structural stop is the binding one.
    for (let i = 0; i < 12; i++) {
      bars.push({ date: dayLabel(60 + i), high: 165, low: 155, close: 160 })
    }
    const entry = bars.at(-1)!.close
    const swingLow = Math.min(...bars.slice(-20).map((b) => b.low))

    const result = computeStopTarget(bars, entry)

    // Pre-buffer behavior put the stop exactly at the swing low, where an intraday
    // probe of the obvious level would tag it before reversing.
    expect(result.stop).not.toBeNull()
    expect(result.stop!).toBeLessThan(swingLow)
    // Still tighter than (or equal to) the pure ATR stop — the buffer must not
    // blow past the volatility-based floor.
    expect(result.stop!).toBeGreaterThanOrEqual(entry - 1.5 * computeATR(bars.slice(-20)))
  })
})

describe('computeStopTarget pivot significance', () => {
  it('ignores a shallow noise pivot and targets the nearest genuinely significant swing high', () => {
    const bars: PriceBar[] = []
    let idx = 0
    const push = (close: number, high?: number, low?: number) => {
      bars.push({ date: dayLabel(idx++), high: high ?? close + 0.5, low: low ?? close - 0.5, close })
    }

    // 60-bar steady base uptrend (101 -> 160), satisfies the SMA60+5 trend check.
    for (let i = 1; i <= 60; i++) push(100 + i)

    // Genuine swing high: sharp spike to a high of 180, then a real ~13% pullback.
    push(175, 180, 174)
    push(168); push(162); push(157)

    // Recovery back up, staying below the 180 spike.
    push(160); push(163); push(166); push(169); push(170)

    // Shallow noise bump: local max under a 3-bar window, but only a ~1% pullback
    // on either side — not a level price ever actually defended.
    push(172, 172.5, 171.5)
    push(171.6, 172.1, 171.1)
    push(171.3, 171.8, 170.8)
    push(171.5, 172.0, 171.0)

    // Entry sits below both the noise bump (172.5) and the real pivot (180).
    push(172)
    const entry = bars.at(-1)!.close

    const result = computeStopTarget(bars, entry)

    // 목표가는 이제 임팩트 투영이 잡으므로 전고점(180)보다 위에 있다. 이 테스트의
    // 관심사인 "얕은 노이즈 봉우리를 저항으로 세지 않는다"는 경유 저항에 적용된다 —
    // 172.5 노이즈가 아니라 실제로 방어된 180이 경유 저항이어야 한다.
    expect(result.target!).toBeGreaterThan(180)
    expect(result.wayResistance).toBeCloseTo(180, 5)
    expect(result.riskReward).toBeGreaterThan(1)
  })
})

describe('임팩트 투영 목표가', () => {
  it('전고점이 아니라 직전 상승폭을 투영한 곳을 목표로 삼는다', () => {
    // 100 → 150 급등(상승폭 50) 후 140까지 눌린 형태.
    // 옛 방식이면 목표가 전고점 150(보상 10)이라 손익비가 바닥났지만,
    // 투영 방식은 눌림 저점 140 + 50 = 190을 목표로 본다.
    const bars: PriceBar[] = []
    for (let i = 0; i < 60; i++) bars.push({ date: dayLabel(i), high: 101, low: 99, close: 100 })
    for (let i = 0; i < 40; i++) {
      const c = 100 + (i + 1) * 1.25
      bars.push({ date: dayLabel(60 + i), high: c + 0.5, low: c - 0.5, close: c })
    }
    for (let i = 0; i < 8; i++) {
      const c = 150 - (i + 1) * 1.25
      bars.push({ date: dayLabel(100 + i), high: c + 0.5, low: c - 0.5, close: c })
    }
    const entry = bars.at(-1)!.close

    const result = computeStopTarget(bars, entry)

    expect(result.frame).toBe('trend')
    expect(result.target).not.toBeNull()
    // 전고점(150)을 넘어선 목표여야 한다
    expect(result.target!).toBeGreaterThan(150)
    expect(result.riskReward!).toBeGreaterThan(1)
  })

  it('목표까지 가는 길에 걸린 저항을 경유 저항으로 알려준다', () => {
    const result = computeStopTarget(makeUptrendBars(120, 100, 1), 219)
    // 경유 저항은 있으면 진입가와 목표 사이에 있어야 한다
    if (result.wayResistance !== null) {
      expect(result.wayResistance).toBeGreaterThan(219)
      expect(result.wayResistance).toBeLessThan(result.target!)
    }
  })
})

describe('박스 기준 손익비', () => {
  it('추세가 없는 종목도 박스 상단을 목표로 손익비를 낸다', () => {
    // 60일선 아래에서 횡보 — 예전에는 손익비가 아예 안 나왔다
    const bars: PriceBar[] = []
    for (let i = 0; i < 80; i++) {
      const c = 200 - i * 1.0
      bars.push({ date: dayLabel(i), high: c + 1, low: c - 1, close: c })
    }
    for (let i = 0; i < 60; i++) {
      const c = 120 + (i % 6)
      bars.push({ date: dayLabel(80 + i), high: c + 1, low: c - 1, close: c })
    }
    const entry = bars.at(-1)!.close

    const result = computeStopTarget(bars, entry)

    expect(result.frame).toBe('range')
    expect(result.riskReward).not.toBeNull()
    expect(result.stop!).toBeLessThan(entry)
    expect(result.target!).toBeGreaterThan(entry)
  })

  it('이미 박스 상단이면 위쪽 여유가 없다고 알린다', () => {
    const bars: PriceBar[] = []
    for (let i = 0; i < 80; i++) {
      const c = 200 - i * 1.0
      bars.push({ date: dayLabel(i), high: c + 1, low: c - 1, close: c })
    }
    for (let i = 0; i < 60; i++) {
      const c = 120 + (i % 6)
      bars.push({ date: dayLabel(80 + i), high: c + 1, low: c - 1, close: c })
    }
    const boxTop = Math.max(...bars.slice(-60).map((b) => b.high))

    const result = computeStopTarget(bars, boxTop + 1)

    expect(result.frame).toBe('range')
    expect(result.reason).toBe('no_upside')
    expect(result.riskReward).toBeNull()
  })
})
