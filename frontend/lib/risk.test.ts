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

    // 172.5 노이즈 봉우리는 프로미넌스도 낮고 보상도 1R에 못 미쳐 목표에서 제외되고,
    // 실제로 방어된 180이 목표가 된다 — 차트에 존재하는 가격이라는 점이 중요하다.
    expect(result.target).toBeCloseTo(180, 5)
    expect(result.riskReward).toBeGreaterThan(1)
    expect(result.targetBasis).toBe('resistance')
  })
})

describe('임팩트 투영 목표가', () => {
  it('위쪽에 의미 있는 저항이 없으면 전고점 너머를 목표로 잡는다', () => {
    // 100 → 150 급등 후 140까지 눌린 형태. 전고점 150은 진입가에서 1R도 안 되는
    // 거리라 목표로서 의미가 없다(옛 방식이 손익비 0.2대를 만들던 자리).
    // 이 경우에만 임팩트를 투영해 전고점 위를 목표로 본다.
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
    expect(result.targetBasis).toBe('resistance')
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

describe('신고가 코앞 2R 기본값', () => {
  it('위쪽에 저항도, 이를 넘는 구간 고점도 없으면 고정 2R을 쓰고 그 근거를 표시한다', () => {
    // 실제 신고된 문제 상황 재현: 60일 이상 꾸준히 오른 종목이 신고가 바로 아래로
    // 살짝(1% 미만) 눌린 형태 — 눌림목 스크리너가 통과시키는 전형적인 모양이다.
    // 되돌림이 얕아 직전 고점은 프로미넌스 기준(3%)에도, 최소 보상 기준(1R)에도
    // 못 미쳐 저항으로 인정되지 않고, 구간 고점도 진입가+2R에 못 미친다 —
    // 이 경우 고정 2R 기본값으로 떨어지는데, 이게 손익비가 2.00에 자주 뭉치는
    // 원인이다(버그가 아니라 이 기본값이 반복 적용된 결과).
    const bars = makeUptrendBars(70, 100, 1)
    const peak = bars.at(-1)!.close
    for (let i = 1; i <= 3; i++) {
      const c = peak - i * 0.5
      bars.push({ date: dayLabel(70 + i - 1), high: c + 0.5, low: c - 0.5, close: c })
    }
    const entry = bars.at(-1)!.close

    const result = computeStopTarget(bars, entry)

    expect(result.frame).toBe('trend')
    expect(result.targetBasis).toBe('default_2r')
    expect(result.riskReward).not.toBeNull()
    expect(result.riskReward!).toBeCloseTo(2, 5)
  })
})

describe('절대 손절폭 상한 (온투이노베이션 2026-08-26 사례)', () => {
  it('변동성이 지나치게 커서 손절이 진입가의 15%를 넘게 떨어지면 표시하지 않는다', () => {
    // 60봉 조용한 우상향(트렌드 게이트 통과) 뒤, 마지막 20봉을 진입가 대비 상하 15%씩
    // 흔드는 변동성 극심 구간으로 바꾼다 — 온투이노베이션처럼 ATR이 지나치게 커서
    // 구조적 손절(entry - 1.5*ATR)이 진입가에서 한참 멀어지는 상황을 재현한다.
    const bars: PriceBar[] = []
    let close = 100
    for (let i = 0; i < 60; i++) {
      close += 1
      bars.push({ date: dayLabel(i), high: close + 0.5, low: close - 0.5, close })
    }
    for (let i = 0; i < 20; i++) {
      bars.push({ date: dayLabel(60 + i), high: 200 * 1.15, low: 200 * 0.85, close: 200 })
    }
    const entry = bars.at(-1)!.close

    const result = computeStopTarget(bars, entry)

    expect(result.reason).toBe('stop_too_far')
    expect(result.frame).toBe('trend')
    expect(result.stop).toBeNull()
    expect(result.riskReward).toBeNull()
  })

  it('평범한 변동성이면 15% 상한에 안 걸리고 정상적으로 손익비가 나온다', () => {
    const bars: PriceBar[] = []
    let close = 100
    for (let i = 0; i < 60; i++) {
      close += 1
      bars.push({ date: dayLabel(i), high: close + 0.5, low: close - 0.5, close })
    }
    for (let i = 0; i < 20; i++) {
      bars.push({ date: dayLabel(60 + i), high: 200 * 1.03, low: 200 * 0.97, close: 200 })
    }
    const entry = bars.at(-1)!.close

    const result = computeStopTarget(bars, entry)

    expect(result.reason).toBe('ok')
    expect(result.stop).not.toBeNull()
    expect((entry - result.stop!) / entry).toBeLessThan(0.15)
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
    expect(result.targetBasis).toBe('range_high')
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
