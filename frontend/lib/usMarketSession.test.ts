import { describe, expect, it } from 'vitest'
import { formatKstDateTime, usBarStatus, usSessionCloseMs } from './usMarketSession'

describe('usSessionCloseMs', () => {
  it('서머타임 기간(EDT, UTC−4)의 마감은 20:00 UTC다', () => {
    expect(new Date(usSessionCloseMs('2026-09-15')).toISOString()).toBe('2026-09-15T20:00:00.000Z')
  })

  it('표준시 기간(EST, UTC−5)의 마감은 21:00 UTC다 — 직접 계산하면 여기서 한 시간 틀린다', () => {
    expect(new Date(usSessionCloseMs('2026-01-15')).toISOString()).toBe('2026-01-15T21:00:00.000Z')
  })

  it('날짜 형식이 아니면 NaN', () => {
    expect(Number.isNaN(usSessionCloseMs('2026/09/15'))).toBe(true)
    expect(Number.isNaN(usSessionCloseMs(''))).toBe(true)
  })
})

describe('usBarStatus', () => {
  it('마감 전에 저장했으면 장중이다', () => {
    // 한국시간 9/16 02:00 = 9/15 17:00 UTC = 9/15 13:00 ET (장중)
    expect(usBarStatus('2026-09-15', '2026-09-15T17:00:00Z')).toBe('intraday')
  })

  it('마감 후에 저장했으면 확정 종가다', () => {
    // 한국시간 9/16 06:30 = 9/15 21:30 UTC = 마감(20:00 UTC) 뒤
    expect(usBarStatus('2026-09-15', '2026-09-15T21:30:00Z')).toBe('final')
  })

  it('마감 시각 정각은 확정으로 본다', () => {
    expect(usBarStatus('2026-09-15', '2026-09-15T20:00:00Z')).toBe('final')
  })

  it('지난 거래일 봉을 오늘 다시 저장해도 확정 종가다', () => {
    // 낮에 도는 실행은 늘 이 경우다 — 이미 끝난 장의 값을 그대로 다시 쓴다.
    expect(usBarStatus('2026-09-14', '2026-09-15T07:49:00Z')).toBe('final')
  })

  it('판정할 수 없으면 final로 밀지 않고 unknown으로 남긴다', () => {
    // 모르는 것을 '마감 종가'로 단정하면 화면이 틀린 말을 하게 된다.
    expect(usBarStatus('', '2026-09-15T21:30:00Z')).toBe('unknown')
    expect(usBarStatus('2026-09-15', 'not-a-date')).toBe('unknown')
  })
})

describe('formatKstDateTime', () => {
  it('UTC 저장 시각을 한국시간으로 옮긴다', () => {
    expect(formatKstDateTime('2026-09-15T17:00:00Z')).toBe('9/16 02:00')
  })

  it('자정을 24시로 주는 구현에서도 00으로 적는다', () => {
    expect(formatKstDateTime('2026-09-15T15:00:00Z')).toBe('9/16 00:00')
  })

  it('못 읽는 값은 빈 문자열 — 화면이 그 줄을 통째로 숨길 수 있게', () => {
    expect(formatKstDateTime('nope')).toBe('')
  })
})
