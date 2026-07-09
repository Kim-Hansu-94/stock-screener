import { describe, expect, it } from 'vitest'
import { scoreOpportunity, type DailyBar } from './opportunityScore'

function bar(i: number, close: number, spread = 2, volume = 1_000_000): DailyBar {
  return {
    date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
    close,
    high: close + spread / 2,
    low: close - spread / 2,
    volume,
  }
}

/** 하락 후 130일째 바닥 다지는 이상적인 베이스: 저점 상승 + 거래량 감소 + 변동성 수축 */
function goodBase(): DailyBar[] {
  const bars: DailyBar[] = []
  // 130일 하락: 200 → 100 (변동성 큼, 거래량 많음)
  for (let i = 0; i < 130; i++) {
    bars.push(bar(i, 200 - (i * 100) / 129, 8, 2_000_000))
  }
  // 130일 횡보: 저점 서서히 상승, 후반부로 갈수록 변동성·거래량 축소
  for (let i = 0; i < 130; i++) {
    const tight = i >= 100
    const close = 102 + i * 0.05 + (tight ? i % 2 : i % 5)
    bars.push(bar(130 + i, close, tight ? 1 : 2, i >= 90 ? 650_000 : 1_000_000))
  }
  return bars
}

describe('scoreOpportunity 하드 필터', () => {
  it('데이터가 120봉 미만이면 null', () => {
    expect(scoreOpportunity(goodBase().slice(0, 100))).toBeNull()
  })

  it('최근 20일 내 52주 신저가 갱신(하락 진행 중) 종목은 제외', () => {
    const bars: DailyBar[] = []
    for (let i = 0; i < 260; i++) bars.push(bar(i, 200 - i * 0.3, 2))
    expect(scoreOpportunity(bars)).toBeNull()
  })

  it('최근 60일 박스폭이 30%를 넘으면(횡보 아님) 제외', () => {
    const bars = goodBase()
    // 마지막 60일 안쪽에 급등 구간을 넣어 박스폭을 벌림 (저점 100 대비 고점 145)
    bars[230] = bar(230, 145, 2)
    expect(scoreOpportunity(bars)).toBeNull()
  })

  it('거래정지 등으로 최근 거래량이 전무하면 제외 (NaN 점수 방지)', () => {
    const bars = goodBase()
    // 마지막 20일 거래 정지: 가격 고정 + 거래량 0
    for (let i = 240; i < 260; i++) {
      bars[i] = { ...bar(i, 110, 0, 0) }
    }
    expect(scoreOpportunity(bars)).toBeNull()
  })

  it('가격이 평평해 ATR이 0이어도 점수가 NaN이 되지 않는다', () => {
    const bars = goodBase()
    // 마지막 70일을 종가 고정·스프레드 0으로 (ATR60 = 0), 거래량은 유지
    for (let i = 190; i < 260; i++) {
      bars[i] = bar(i, 110, 0, 700_000)
    }
    const result = scoreOpportunity(bars)
    if (result !== null) {
      expect(Number.isFinite(result.score)).toBe(true)
    }
  })
})

describe('scoreOpportunity 점수', () => {
  it('이상적인 베이스는 통과하고 신호들이 잡힌다', () => {
    const result = scoreOpportunity(goodBase())
    expect(result).not.toBeNull()
    expect(result!.score).toBeGreaterThan(0.7)
    expect(result!.score).toBeLessThanOrEqual(1)
    expect(result!.daysSinceLow).toBeGreaterThan(100)
    expect(result!.vcp).toBe(true)
    expect(result!.higherLows).toBe(true)
    expect(result!.volumeDry).toBe(true)
  })

  it('바닥 다진 지 오래된 종목이 갓 하락 멈춘 종목보다 점수가 높다', () => {
    const seasoned = scoreOpportunity(goodBase())!

    // 하락 235일 + 횡보 25일: 신저가 필터는 통과하지만 바닥 이력이 짧음
    const fresh: DailyBar[] = []
    for (let i = 0; i < 235; i++) fresh.push(bar(i, 200 - (i * 100) / 234, 8, 2_000_000))
    for (let i = 0; i < 25; i++) fresh.push(bar(235 + i, 102 + (i % 5), 2, 2_000_000))
    const freshResult = scoreOpportunity(fresh)
    expect(freshResult).not.toBeNull()
    expect(seasoned.score).toBeGreaterThan(freshResult!.score)
  })

  it('이평 정배열 보너스가 반영되고 점수는 1.0을 넘지 않는다', () => {
    const bars = goodBase()
    // 마지막 5일을 완만한 상승으로 마감 → close > SMA5 > SMA20 > SMA60
    for (let i = 0; i < 5; i++) {
      bars[255 + i] = bar(255 + i, 112 + i * 0.8, 2, 700_000)
    }
    const result = scoreOpportunity(bars)
    expect(result).not.toBeNull()
    expect(result!.alignedMAs).toBe(true)
    expect(result!.score).toBeLessThanOrEqual(1)
  })

  it('당일 거래량이 90일 평균 2배 이상이면 거래량 트리거', () => {
    const bars = goodBase()
    const last = bars[bars.length - 1]
    bars[bars.length - 1] = { ...last, volume: 5_000_000 }
    const result = scoreOpportunity(bars)
    expect(result).not.toBeNull()
    expect(result!.volumeTrigger).toBe(true)
  })
})
