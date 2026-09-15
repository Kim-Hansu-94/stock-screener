import { describe, it, expect } from 'vitest'
import { holdHint } from './holdHint'

describe('holdHint', () => {
  it('값이 없으면 배지를 붙이지 않는다', () => {
    // pattern_match_results_drawdown.sql을 실행하기 전 상태. 모르는 값을
    // '3개월'로 단정하면 사용자가 깊은 종목을 3개월에 손절하게 된다.
    expect(holdHint(null)).toBeNull()
    expect(holdHint(Number.NaN)).toBeNull()
  })

  it('65% 미만은 3개월', () => {
    expect(holdHint(58.4)?.label).toBe('⏳ 3개월')
    expect(holdHint(64.9)?.label).toBe('⏳ 3개월')
  })

  it('65~70%는 경계 구간이라 단정하지 않는다', () => {
    expect(holdHint(65)?.label).toBe('⏳ 3~12개월')
    expect(holdHint(69.9)?.label).toBe('⏳ 3~12개월')
  })

  it('70% 이상은 1년', () => {
    expect(holdHint(70)?.label).toBe('⏳ 1년')
    expect(holdHint(83.2)?.label).toBe('⏳ 1년')
  })

  it('부호를 가리지 않는다', () => {
    // 하락률을 음수로 넣는 소스가 섞여도 같은 칸으로 간다.
    expect(holdHint(-72)?.label).toBe(holdHint(72)?.label)
  })

  it('설명에 실제 하락률을 그대로 적는다', () => {
    expect(holdHint(72.4)?.title).toContain('72%')
  })
})
