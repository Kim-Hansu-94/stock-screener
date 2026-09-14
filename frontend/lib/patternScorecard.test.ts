import { describe, expect, it } from 'vitest'
import type { PriceBar } from './risk'
import {
  BIG_MOVE_PCT,
  PATTERN_EARLY_BARS,
  PATTERN_HOLD_BARS,
  type PatternFeatures,
  type PatternRecInput,
  daysSinceLowBucket,
  drawdownBucket,
  patternVerdictOf,
  rankBucket,
  resolvePatternRec,
  segmentPatternBy,
  summarizePattern,
} from './patternScorecard'

const NO_FEATURES: PatternFeatures = {
  score: null, drawdownPct: null, daysSinceLow: null, volRatio: null,
  vcp: null, maAlign: null, higherLow: null, volumeTriggered: null,
}

function bars(specs: Array<{ high: number; low: number; close: number }>): PriceBar[] {
  return specs.map((s, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, ...s }))
}

/** n개의 평평한 봉. close만 지정하면 high/low는 ±5%. */
const flat = (n: number, close: number) =>
  bars(Array.from({ length: n }, () => ({ high: close * 1.05, low: close * 0.95, close })))

/** 진입가 10달러 추천 하나. */
function rec(futureBars: PriceBar[], features: PatternFeatures = NO_FEATURES): PatternRecInput {
  return {
    date: '2026-01-01', ticker: 'QBTS', name: 'D-Wave', sector: 'Technology',
    rank: 1, entry: 10, futureBars, features,
  }
}

describe('resolvePatternRec', () => {
  it('관찰 기간을 채우면 그 시점 종가로 수익률을 낸다', () => {
    const r = resolvePatternRec(rec(flat(PATTERN_HOLD_BARS, 13)))
    expect(r.settled).toBe(true)
    expect(r.returnPct).toBeCloseTo(30)
  })

  it('관찰 기간을 못 채우면 결과를 모르는 것으로 둔다', () => {
    const r = resolvePatternRec(rec(flat(PATTERN_HOLD_BARS - 1, 20)))
    expect(r.settled).toBe(false)
    expect(r.returnPct).toBeNull()
    expect(r.maxGainPct).toBeNull()
  })

  it('기간이 안 찼어도 1개월 수익률은 미리 낸다', () => {
    const r = resolvePatternRec(rec(flat(PATTERN_EARLY_BARS, 11)))
    expect(r.settled).toBe(false)
    expect(r.earlyReturnPct).toBeCloseTo(10)
  })

  it('최대 상승·하락은 고가와 저가로 잰다 (종가가 아니라)', () => {
    const path = [
      ...flat(10, 10),
      ...bars([{ high: 25, low: 9, close: 12 }]), // 장중 +150%까지 갔다가 되밀림
      ...bars([{ high: 12, low: 4, close: 5 }]), // 장중 -60%까지 빠짐
      ...flat(PATTERN_HOLD_BARS - 12, 10),
    ]
    const r = resolvePatternRec(rec(path))
    expect(r.maxGainPct).toBeCloseTo(150)
    expect(r.maxDropPct).toBeCloseTo(-60)
    expect(r.returnPct).toBeCloseTo(0)
  })

  it('관찰 기간 뒤의 봉은 보지 않는다', () => {
    const path = [...flat(PATTERN_HOLD_BARS, 10), ...flat(20, 100)]
    const r = resolvePatternRec(rec(path))
    expect(r.returnPct).toBeCloseTo(0)
    expect(r.maxGainPct).toBeLessThan(10)
  })

  it('진입가가 0이면 아무것도 계산하지 않는다', () => {
    const r = resolvePatternRec({ ...rec(flat(PATTERN_HOLD_BARS, 10)), entry: 0 })
    expect(r.settled).toBe(false)
    expect(r.returnPct).toBeNull()
  })
})

describe('summarizePattern', () => {
  const settledAt = (close: number) => resolvePatternRec(rec(flat(PATTERN_HOLD_BARS, close)))

  it('판정 안 끝난 추천은 분모에서 빼고 건수만 남긴다', () => {
    const card = summarizePattern([
      settledAt(12),
      resolvePatternRec(rec(flat(5, 30))), // pending — 여기 껴 있으면 평균이 부풀려진다
    ])
    expect(card.settled).toBe(1)
    expect(card.pending).toBe(1)
    expect(card.avgReturnPct).toBeCloseTo(20)
  })

  it('평균과 중간값이 갈리면 쏠림으로 표시한다', () => {
    // 9건은 -10%, 1건은 +200% → 평균은 플러스지만 열에 아홉은 손실이다
    const card = summarizePattern([
      ...Array.from({ length: 9 }, () => settledAt(9)),
      settledAt(30),
    ])
    expect(card.avgReturnPct).toBeGreaterThan(0)
    expect(card.medianReturnPct).toBeLessThan(0)
    expect(card.skewed).toBe(true)
  })

  it('크게 오른 비율과 크게 빠진 비율을 따로 센다', () => {
    const card = summarizePattern([
      settledAt(10 * (1 + BIG_MOVE_PCT / 100)),
      settledAt(10 * (1 - BIG_MOVE_PCT / 100)),
      settledAt(10.5),
      settledAt(9.5),
    ])
    expect(card.bigWinRate).toBeCloseTo(0.25)
    expect(card.bigLossRate).toBeCloseTo(0.25)
    expect(card.winRate).toBeCloseTo(0.5)
  })

  it('판정 완료가 없으면 0으로 채우고 진행 중 건수만 알린다', () => {
    const card = summarizePattern([resolvePatternRec(rec(flat(3, 10)))])
    expect(card.settled).toBe(0)
    expect(card.pending).toBe(1)
    expect(card.avgReturnPct).toBe(0)
  })
})

describe('patternVerdictOf', () => {
  const card = (over: Partial<ReturnType<typeof summarizePattern>>) => ({
    ...summarizePattern([]), settled: 40, ...over,
  })

  it('표본 20건 미만이면 숫자가 좋아도 단정하지 않는다', () => {
    expect(patternVerdictOf(card({ settled: 19, avgReturnPct: 50, medianReturnPct: 40 }))).toBe('insufficient')
  })

  it('평균이 0 이하면 우위 없음', () => {
    expect(patternVerdictOf(card({ avgReturnPct: -3, medianReturnPct: -5 }))).toBe('negative')
  })

  it('평균은 플러스여도 중간값이 마이너스면 약한 우위로만 본다', () => {
    expect(patternVerdictOf(card({ avgReturnPct: 20, medianReturnPct: -4, skewed: true }))).toBe('marginal')
  })

  it('평균과 중간값이 같이 플러스면 따라갈 만하다고 본다', () => {
    expect(patternVerdictOf(card({ avgReturnPct: 12, medianReturnPct: 6 }))).toBe('positive')
  })
})

describe('segmentPatternBy', () => {
  const withDays = (days: number, close: number) =>
    resolvePatternRec(rec(flat(PATTERN_HOLD_BARS, close), { ...NO_FEATURES, daysSinceLow: days }))

  it('표본이 적은 구간은 착시라 잘라낸다', () => {
    const segments = segmentPatternBy(
      [
        ...Array.from({ length: 6 }, () => withDays(20, 12)),
        ...Array.from({ length: 2 }, () => withDays(70, 30)), // 2건뿐 — 빠져야 한다
      ],
      (r) => daysSinceLowBucket(r.features.daysSinceLow),
    )
    expect(segments).toHaveLength(1)
    expect(segments[0].key).toBe('1')
  })

  it('특성이 기록되지 않은 추천은 구간에 넣지 않는다', () => {
    const segments = segmentPatternBy(
      Array.from({ length: 10 }, () => resolvePatternRec(rec(flat(PATTERN_HOLD_BARS, 12)))),
      (r) => daysSinceLowBucket(r.features.daysSinceLow),
    )
    expect(segments).toHaveLength(0)
  })

  it('평균 수익률 내림차순으로 정렬한다', () => {
    const segments = segmentPatternBy(
      [
        ...Array.from({ length: 5 }, () => withDays(20, 9)),
        ...Array.from({ length: 5 }, () => withDays(70, 15)),
      ],
      (r) => daysSinceLowBucket(r.features.daysSinceLow),
    )
    expect(segments.map((s) => s.key)).toEqual(['4', '1'])
  })
})

describe('구간 나누기', () => {
  it('소진일수 구간', () => {
    expect(daysSinceLowBucket(15)).toBe('1')
    expect(daysSinceLowBucket(29)).toBe('1')
    expect(daysSinceLowBucket(30)).toBe('2')
    expect(daysSinceLowBucket(59)).toBe('3')
    expect(daysSinceLowBucket(60)).toBe('4')
    expect(daysSinceLowBucket(null)).toBeNull()
  })

  it('하락률 구간', () => {
    expect(drawdownBucket(60)).toBe('1')
    expect(drawdownBucket(70)).toBe('2')
    expect(drawdownBucket(80)).toBe('3')
    expect(drawdownBucket(null)).toBeNull()
  })

  it('순위 구간', () => {
    expect(rankBucket(1)).toBe('1')
    expect(rankBucket(5)).toBe('1')
    expect(rankBucket(6)).toBe('2')
    expect(rankBucket(20)).toBe('3')
  })
})
