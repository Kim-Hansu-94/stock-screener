import { describe, expect, it } from 'vitest'
import type { PriceBar } from './risk'
import { findExitSignal, signalReturnPct, type ExitScanInput } from './exitSignal'

/** 60일선을 확실히 위에 두기 위해 진입 전 구간을 낮은 가격으로 길게 깐다. */
function trailing(n = 80, close = 80): PriceBar[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2025-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    high: close + 1, low: close - 1, close,
  }))
}

function bar(date: string, close: number, high = close + 1, low = close - 1): PriceBar {
  return { date, high, low, close }
}

function input(over: Partial<ExitScanInput>): ExitScanInput {
  return {
    futureBars: [],
    trailingBars: trailing(),
    stop: 90,
    target: 130,
    sector: 'Semiconductors',
    regimeByDate: {},
    leadingSectorsByDate: {},
    ...over,
  }
}

describe('findExitSignal', () => {
  it('아무 조건도 안 걸리면 계속 보유(null)', () => {
    // 종가 100은 trailing(80) 덕분에 60일선 위다
    const bars = [bar('2026-01-02', 100), bar('2026-01-03', 101)]
    expect(findExitSignal(input({ futureBars: bars }))).toBeNull()
  })

  it('손절가에 닿으면 그 가격에 체결된 것으로 본다', () => {
    const bars = [bar('2026-01-02', 95, 96, 89)]
    const sig = findExitSignal(input({ futureBars: bars }))
    expect(sig).toEqual({ date: '2026-01-02', price: 90, reasons: ['stop'] })
  })

  it('목표가에 닿으면 목표가로 체결된 것으로 본다', () => {
    const bars = [bar('2026-01-02', 128, 131, 127)]
    const sig = findExitSignal(input({ futureBars: bars }))
    expect(sig).toEqual({ date: '2026-01-02', price: 130, reasons: ['target'] })
  })

  it('하락장으로 바뀐 날을 잡아낸다', () => {
    const bars = [bar('2026-01-02', 100), bar('2026-01-05', 101)]
    const sig = findExitSignal(input({
      futureBars: bars,
      regimeByDate: { '2026-01-05': 'bear' },
    }))
    expect(sig?.date).toBe('2026-01-05')
    expect(sig?.reasons).toContain('bear')
    expect(sig?.price).toBe(101)
  })

  it('주도 섹터에서 빠진 날을 잡아낸다', () => {
    const bars = [bar('2026-01-02', 100)]
    const sig = findExitSignal(input({
      futureBars: bars,
      leadingSectorsByDate: { '2026-01-02': ['Financials', 'Energy'] },
    }))
    expect(sig?.reasons).toContain('sector')
  })

  it('그날 주도 섹터 데이터가 없으면 이탈로 세지 않는다', () => {
    // 파이프라인이 안 돈 날의 빈 데이터를 매도 신호로 둔갑시키면 안 된다
    const bars = [bar('2026-01-02', 100)]
    expect(findExitSignal(input({ futureBars: bars, leadingSectorsByDate: {} }))).toBeNull()
    expect(findExitSignal(input({ futureBars: bars, leadingSectorsByDate: { '2026-01-02': [] } }))).toBeNull()
  })

  it('60일선을 깨는 날을 잡아낸다', () => {
    // trailing 80봉이 80이므로 60일선은 80 근처 — 종가 70이면 하회
    const bars = [bar('2026-01-02', 70)]
    const sig = findExitSignal(input({ futureBars: bars, stop: null, target: null }))
    expect(sig?.reasons).toContain('trend')
  })

  it('가장 먼저 걸린 날을 돌려준다', () => {
    const bars = [bar('2026-01-02', 100), bar('2026-01-05', 100), bar('2026-01-06', 100)]
    const sig = findExitSignal(input({
      futureBars: bars,
      regimeByDate: { '2026-01-05': 'bear', '2026-01-06': 'bear' },
    }))
    expect(sig?.date).toBe('2026-01-05')
  })

  it('손절과 정황 신호가 같은 날이면 손절이 우선한다', () => {
    const bars = [bar('2026-01-02', 95, 96, 89)]
    const sig = findExitSignal(input({
      futureBars: bars,
      regimeByDate: { '2026-01-02': 'bear' },
    }))
    expect(sig?.reasons).toEqual(['stop'])
  })
})

describe('signalReturnPct', () => {
  it('신호일에 팔았다면의 수익률', () => {
    expect(signalReturnPct(100, { date: 'x', price: 110, reasons: ['bear'] })).toBeCloseTo(10)
    expect(signalReturnPct(100, { date: 'x', price: 90, reasons: ['stop'] })).toBeCloseTo(-10)
  })
})
