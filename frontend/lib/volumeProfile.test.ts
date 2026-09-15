import { describe, expect, it } from 'vitest'
import { computeVolumeProfile } from './volumeProfile'
import type { PriceHistoryRow } from './types'

function bar(low: number, high: number, volume: number): PriceHistoryRow {
  return {
    ticker: 'TEST',
    market: 'KR',
    date: '2026-01-01',
    open: low,
    high,
    low,
    close: high,
    volume,
  }
}

describe('computeVolumeProfile', () => {
  it('거래량 전부를 구간에 나눠 담는다 (합이 보존된다)', () => {
    const profile = computeVolumeProfile([bar(100, 110, 300), bar(105, 115, 700)], 10)!
    expect(profile.totalVolume).toBeCloseTo(1000, 6)
    expect(profile.bins.reduce((a, b) => a + b.volume, 0)).toBeCloseTo(1000, 6)
  })

  it('가장 두꺼운 가격대(POC)는 봉들이 겹친 구간에서 나온다', () => {
    // 100~110이 다섯 번, 200~210이 한 번 → 매물대 중심은 100~110 쪽이어야 한다.
    const bars = [
      ...Array.from({ length: 5 }, () => bar(100, 110, 1000)),
      bar(200, 210, 1000),
    ]
    const profile = computeVolumeProfile(bars, 22)!
    expect(profile.pocPrice).toBeGreaterThan(100)
    expect(profile.pocPrice).toBeLessThan(110)
  })

  it('구간은 전체 저가~고가를 빈틈없이 덮는다', () => {
    const profile = computeVolumeProfile([bar(100, 110, 100), bar(90, 95, 100)], 4)!
    expect(profile.bins[0].low).toBeCloseTo(90, 6)
    expect(profile.bins[profile.bins.length - 1].high).toBeCloseTo(110, 6)
    for (let i = 1; i < profile.bins.length; i++) {
      expect(profile.bins[i].low).toBeCloseTo(profile.bins[i - 1].high, 6)
    }
  })

  it('고가=저가(상한가처럼 한 가격에만 체결)여도 거래량을 잃지 않는다', () => {
    const profile = computeVolumeProfile([bar(100, 100, 500), bar(100, 120, 500)], 10)!
    expect(profile.totalVolume).toBeCloseTo(1000, 6)
  })

  it('그릴 수 없는 입력은 null — 화면이 매물대만 빼고 그릴 수 있게 한다', () => {
    expect(computeVolumeProfile([], 10)).toBeNull()
    // 가격이 전부 같으면 나눌 구간이 없다.
    expect(computeVolumeProfile([bar(100, 100, 500)], 10)).toBeNull()
    // 거래량을 안 주는 소스(전부 0)
    expect(computeVolumeProfile([bar(100, 110, 0), bar(105, 115, 0)], 10)).toBeNull()
  })

  it('maxVolume은 실제 최대 구간 거래량과 일치한다 (막대 길이 정규화의 기준)', () => {
    const profile = computeVolumeProfile([bar(100, 110, 300), bar(100, 102, 900)], 10)!
    expect(profile.maxVolume).toBeCloseTo(Math.max(...profile.bins.map((b) => b.volume)), 6)
  })
})
