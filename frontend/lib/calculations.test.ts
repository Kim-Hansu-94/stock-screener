import { describe, expect, it } from 'vitest'
import { calculateChangePercent, simpleMovingAverage } from './calculations'

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
