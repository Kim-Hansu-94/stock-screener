import { describe, expect, it } from 'vitest'
import {
  DISTRIBUTIONS,
  DISTRIBUTION_TAX_RATE,
  analyzeExDates,
  describeExDate,
  summarizeDistributions,
  type CloseBar,
  type Distribution,
} from './etfDistribution'

// 2026-09-29 실측(사용자가 증권사 앱에서 확인): 전날 종가 14,245 → 배당락일 종가 14,120, 분배금 188.
const SEP: Distribution = { exDate: '2026-09-29', payDate: '2026-10-02', amount: 188 }
const bars: CloseBar[] = [
  { date: '2026-09-25', close: 14300 },
  { date: '2026-09-28', close: 14245 },
  { date: '2026-09-29', close: 14120 },
  { date: '2026-09-30', close: 14200 },
]

describe('analyzeExDates — 실측 사례', () => {
  const [r] = analyzeExDates(bars, [SEP])

  it('화면 등락과 분배금을 더한 실질 등락을 따로 낸다', () => {
    expect(r.status).toBe('ok')
    expect(r.prevClose).toBe(14245)
    expect(r.refPrice).toBe(14057) // 14,245 - 188
    expect(r.screenChange).toBe(-125)
    expect(r.realChange).toBe(63) // 14,120 + 188 - 14,245
  })

  it('두 등락률의 차이는 정확히 분배율이다 (분모가 같다)', () => {
    expect(r.screenChangePct).toBeCloseTo(-0.8775, 3)
    expect(r.realChangePct).toBeCloseTo(0.4423, 3)
    expect(r.yieldPct).toBeCloseTo(1.3198, 3)
    expect(r.realChangePct! - r.screenChangePct!).toBeCloseTo(r.yieldPct!, 10)
  })

  it('세후 분배금은 가정 세율로 뗀다', () => {
    expect(DISTRIBUTION_TAX_RATE).toBe(0.154)
    expect(r.afterTaxAmount).toBeCloseTo(188 * 0.846, 10)
  })

  it('화면에서는 내렸지만 실질은 오른 경우를 그대로 말한다', () => {
    expect(describeExDate(r)).toBe('화면에서는 내렸지만, 분배금을 더하면 실제로는 올랐습니다.')
  })
})

describe('지급 상태', () => {
  it('최신 일봉이 지급일 전이면 지급 예정이다', () => {
    expect(analyzeExDates(bars, [SEP])[0].payStatus).toBe('pending')
  })

  it('최신 일봉이 지급일 이후면 지급 완료다', () => {
    const later = [...bars, { date: '2026-10-02', close: 14150 }]
    expect(analyzeExDates(later, [SEP])[0].payStatus).toBe('paid')
  })

  it('기준일을 알 수 없으면 지급 완료로 단정하지 않는다', () => {
    expect(analyzeExDates([], [SEP])[0].payStatus).toBe('pending')
  })

  it('지급일을 모르면 지급 완료로 단정하지 않고 배지 자체를 없앤다', () => {
    const unknown: Distribution = { exDate: '2026-09-29', amount: 188 }
    expect(analyzeExDates(bars, [unknown])[0].payStatus).toBeNull()
  })
})

describe('DISTRIBUTIONS (손으로 적은 목록)', () => {
  it('배당락일 오름차순이고 중복이 없으며 금액이 양수다', () => {
    const days = DISTRIBUTIONS.map((d) => d.exDate)
    expect(days).toEqual([...days].sort())
    expect(new Set(days).size).toBe(days.length)
    for (const d of DISTRIBUTIONS) expect(d.amount).toBeGreaterThan(0)
  })

  it('최근 12개월 합계가 네이버 요약(dividendPerShareTtm=2905)과 정확히 같다', () => {
    // 2026-09-30에 프로브로 받은 값. 기간을 날짜로 묶어 두어 새 분배금을 더해도 이 검산은 유효하다.
    const ttm = DISTRIBUTIONS.filter((d) => d.exDate > '2025-09-30' && d.exDate <= '2026-09-29')
    expect(ttm).toHaveLength(12)
    expect(ttm.reduce((sum, d) => sum + d.amount, 0)).toBe(2905)
  })

  it('올해 횟수는 9회다 (네이버 dividendCountThisYear=9, 1~9월 매달)', () => {
    const thisYear = DISTRIBUTIONS.filter((d) => d.exDate.startsWith('2026-') && d.exDate <= '2026-09-29')
    expect(thisYear.map((d) => Number(d.exDate.slice(5, 7)))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('지급일이 있으면 배당락일보다 뒤다', () => {
    for (const d of DISTRIBUTIONS) if (d.payDate) expect(d.payDate > d.exDate).toBe(true)
  })

  it('실측 사례(2026-09-29, 188원)가 들어 있다', () => {
    expect(DISTRIBUTIONS.find((d) => d.exDate === '2026-09-29')).toEqual({
      exDate: '2026-09-29',
      payDate: '2026-10-02',
      amount: 188,
    })
  })
})

describe('일봉이 모자란 경우', () => {
  it('배당락일 일봉이 없으면 근처 날짜로 대체하지 않는다', () => {
    const noExBar = bars.filter((b) => b.date !== '2026-09-29')
    const [r] = analyzeExDates(noExBar, [SEP])
    expect(r.status).toBe('no-bar')
    expect(r.screenChange).toBeNull()
    expect(r.realChange).toBeNull()
    expect(describeExDate(r)).toContain('아직 없어')
  })

  it('배당락일이 첫 일봉이면 전날이 없어 비교 불가다', () => {
    const [r] = analyzeExDates(bars.slice(2), [SEP])
    expect(r.status).toBe('no-prev')
    expect(describeExDate(r)).toContain('전날 일봉이 없어')
  })
})

describe('describeExDate — 나머지 경우', () => {
  const at = (close: number) =>
    analyzeExDates(
      [
        { date: '2026-09-28', close: 14245 },
        { date: '2026-09-29', close },
      ],
      [SEP],
    )[0]

  it('분배금을 받고도 오른 경우', () => {
    expect(describeExDate(at(14300))).toBe('분배금을 받고도 가격이 올랐습니다.')
  })

  it('분배금을 더해도 내린 경우는 기초자산 탓이라고 말한다', () => {
    expect(describeExDate(at(13900))).toContain('기초자산이 내린 영향')
  })

  it('딱 본전인 경우', () => {
    expect(describeExDate(at(14245 - 188))).toBe('분배금을 더하면 딱 본전입니다.')
  })
})

describe('summarizeDistributions', () => {
  it('첫 배당락일 전날 종가부터 최신 종가까지 분배금을 더한 총수익을 낸다', () => {
    const results = analyzeExDates(bars, [SEP])
    const s = summarizeDistributions(results, bars)!
    expect(s.baseClose).toBe(14245)
    expect(s.baseDate).toBe('2026-09-28')
    expect(s.latestClose).toBe(14200)
    expect(s.latestDate).toBe('2026-09-30')
    expect(s.count).toBe(1)
    expect(s.totalAmount).toBe(188)
    expect(s.priceChange).toBe(-45)
    expect(s.totalReturn).toBe(143) // -45 + 188
    expect(s.totalReturnPct).toBeCloseTo((143 / 14245) * 100, 10)
    expect(s.totalReturnAfterTax).toBeCloseTo(-45 + 188 * 0.846, 10)
  })

  it('분배금이 둘이면 합산한다', () => {
    const two: CloseBar[] = [
      { date: '2026-09-28', close: 14245 },
      { date: '2026-09-29', close: 14120 },
      { date: '2026-10-28', close: 14000 },
      { date: '2026-10-29', close: 13900 },
    ]
    const dists: Distribution[] = [SEP, { exDate: '2026-10-29', payDate: '2026-11-03', amount: 200 }]
    const s = summarizeDistributions(analyzeExDates(two, dists), two)!
    expect(s.count).toBe(2)
    expect(s.totalAmount).toBe(388)
    expect(s.priceChange).toBe(13900 - 14245)
    expect(s.totalReturn).toBe(13900 - 14245 + 388)
  })

  it('중간 분배금의 일봉이 빠지면 틀린 합계 대신 null을 돌려준다', () => {
    const missingMiddle: CloseBar[] = [
      { date: '2026-09-28', close: 14245 },
      { date: '2026-09-29', close: 14120 },
      { date: '2026-10-29', close: 13900 },
    ]
    const dists: Distribution[] = [
      SEP,
      { exDate: '2026-10-15', payDate: '2026-10-20', amount: 200 }, // 이 배당락일의 일봉이 없다
    ]
    expect(summarizeDistributions(analyzeExDates(missingMiddle, dists), missingMiddle)).toBeNull()
  })

  it('계산 가능한 분배금이 없으면 null', () => {
    expect(summarizeDistributions(analyzeExDates([], [SEP]), [])).toBeNull()
    expect(summarizeDistributions(analyzeExDates(bars.slice(0, 2), [SEP]), bars.slice(0, 2))).toBeNull()
  })
})
