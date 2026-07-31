import { describe, expect, it } from 'vitest'
import { buyGrade } from './buySignal'

describe('buyGrade', () => {
  it('grades a fully formed base as strong', () => {
    expect(buyGrade(0.85, true)).toBe('strong')
    expect(buyGrade(0.8, true)).toBe('strong')
  })

  it('grades a completed base as consider', () => {
    expect(buyGrade(0.72, true)).toBe('consider')
    expect(buyGrade(0.7, true)).toBe('consider')
  })

  it('keeps below-threshold scores at watch', () => {
    expect(buyGrade(0.69, true)).toBe('watch')
    expect(buyGrade(0.4, true)).toBe('watch')
  })

  it('forces watch when higher lows are absent, however high the score', () => {
    // 점수만 높고 저점이 계속 낮아지는 종목은 바닥이 아니므로 등급을 주지 않는다.
    expect(buyGrade(0.95, false)).toBe('watch')
    expect(buyGrade(0.75, false)).toBe('watch')
  })

  it('treats missing data as watch', () => {
    expect(buyGrade(null, true)).toBe('watch')
    expect(buyGrade(0.9, null)).toBe('watch')
  })
})
