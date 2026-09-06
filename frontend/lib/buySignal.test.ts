import { describe, expect, it } from 'vitest'
import {
  buyGrade, daysSinceQualified, isFreshTurnSignal, isNewEntry,
  NEW_ENTRY_WINDOW_DAYS, TURN_SIGNAL_WINDOW_DAYS,
} from './buySignal'

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

describe('daysSinceQualified', () => {
  const today = new Date('2026-09-06T00:00:00Z')

  it('counts whole days between qualified_since and today', () => {
    expect(daysSinceQualified('2026-09-06', today)).toBe(0)
    expect(daysSinceQualified('2026-09-03', today)).toBe(3)
    expect(daysSinceQualified('2026-01-30', today)).toBe(219)
  })

  it('returns null when data is missing or malformed', () => {
    expect(daysSinceQualified(null, today)).toBeNull()
    expect(daysSinceQualified('not-a-date', today)).toBeNull()
  })
})

describe('isNewEntry', () => {
  const today = new Date('2026-09-06T00:00:00Z')

  it('is true within the freshness window (inclusive)', () => {
    expect(isNewEntry('2026-09-06', today)).toBe(true)
    expect(isNewEntry('2026-09-03', today)).toBe(true) // exactly NEW_ENTRY_WINDOW_DAYS
  })

  it('is false once it has been qualifying longer than the window', () => {
    expect(isNewEntry('2026-09-02', today)).toBe(false)
    expect(isNewEntry('2026-01-30', today)).toBe(false) // NH투자증권우 사례 — 249일째
  })

  it('is false when there is no qualified_since to judge freshness by', () => {
    expect(isNewEntry(null, today)).toBe(false)
  })

  it('keeps the window at 3 days', () => {
    // 이 값을 바꾸면 신규 진입 배지가 뜨는 기간이 바뀐다 — 의도적 변경이 아니면 실패해야 한다.
    expect(NEW_ENTRY_WINDOW_DAYS).toBe(3)
  })
})

describe('isFreshTurnSignal', () => {
  const today = new Date('2026-09-06T00:00:00Z')

  it('is true right when the turn just started (inclusive of the window)', () => {
    expect(isFreshTurnSignal('2026-09-06', today)).toBe(true)
    expect(isFreshTurnSignal('2026-09-01', today)).toBe(true) // exactly TURN_SIGNAL_WINDOW_DAYS
  })

  it('is false once the trend has been aligned longer than the window', () => {
    // 후보로 뜬 지는 오래됐어도(qualified_since) 정배열 자체는 예전에 이미 꺾였을 수
    // 있다 — 그 경우 "막 전환"으로 보여주면 안 된다.
    expect(isFreshTurnSignal('2026-08-31', today)).toBe(false)
  })

  it('is false when there is no alignment to judge freshness by', () => {
    expect(isFreshTurnSignal(null, today)).toBe(false)
  })

  it('keeps the window at 5 days', () => {
    expect(TURN_SIGNAL_WINDOW_DAYS).toBe(5)
  })
})
