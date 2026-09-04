import { describe, expect, it } from 'vitest'
import { calculateChangePercent, ichimokuLines, simpleMovingAverage } from './calculations'

describe('calculateChangePercent', () => {
  it('returns null when fewer than two closes are given', () => {
    expect(calculateChangePercent([100])).toBeNull()
    expect(calculateChangePercent([])).toBeNull()
  })

  it('returns the percent change between the last two closes', () => {
    expect(calculateChangePercent([100, 110])).toBeCloseTo(10)
  })

  it('returns a negative percent when price dropped', () => {
    expect(calculateChangePercent([100, 95])).toBeCloseTo(-5)
  })

  it('returns null when the previous close is zero', () => {
    expect(calculateChangePercent([0, 50])).toBeNull()
  })
})

describe('simpleMovingAverage', () => {
  it('returns null for indices before the window is full', () => {
    expect(simpleMovingAverage([1, 2], 3)).toEqual([null, null])
  })

  it('computes the average over the trailing window', () => {
    expect(simpleMovingAverage([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })
})

describe('ichimokuLines', () => {
  // 작은 윈도우(2/3/4)로 손계산 가능한 값만 확인한다 — 실제 사용값(9/26/52)은
  // 같은 midpoint(고가+저가)/2 로직이라 윈도우 크기만 다르다.
  const highs = [10, 12, 11, 13, 15]
  const lows = [8, 9, 9, 10, 11]
  const opts = { tenkanWindow: 2, kijunWindow: 3, senkouBWindow: 4 }

  it('전환선·기준선은 윈도우가 다 찰 때까지 null', () => {
    const { tenkan, kijun } = ichimokuLines(highs, lows, opts)
    expect(tenkan[0]).toBeNull()
    expect(kijun[0]).toBeNull()
    expect(kijun[1]).toBeNull()
  })

  it('(구간 고가+구간 저가)/2 로 전환선·기준선·선행스팬B를 계산한다', () => {
    const { tenkan, kijun, senkouB } = ichimokuLines(highs, lows, opts)
    expect(tenkan[1]).toBeCloseTo((12 + 8) / 2) // 인덱스 0~1: 고가12, 저가8
    expect(kijun[2]).toBeCloseTo((12 + 8) / 2) // 인덱스 0~2: 고가12, 저가8
    expect(senkouB[3]).toBeCloseTo((13 + 8) / 2) // 인덱스 0~3: 고가13, 저가8
  })

  it('선행스팬A는 전환선과 기준선의 중간값', () => {
    const { tenkan, kijun, senkouA } = ichimokuLines(highs, lows, opts)
    for (let i = 0; i < highs.length; i++) {
      if (tenkan[i] === null || kijun[i] === null) {
        expect(senkouA[i]).toBeNull()
      } else {
        expect(senkouA[i]).toBeCloseTo((tenkan[i]! + kijun[i]!) / 2)
      }
    }
  })
})
