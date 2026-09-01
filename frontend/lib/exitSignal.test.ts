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
    // 아래 기존 테스트들은 전부 눌림목 규칙(장세·섹터·60일선)을 검증한다.
    source: 'pullback',
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

/** 대량거래 음봉 판정에 필요한 open/volume까지 채운 봉. */
function fullBar(
  date: string,
  { open, close, volume, high, low }:
    { open: number; close: number; volume: number; high?: number; low?: number },
): PriceBar {
  return {
    date,
    open,
    close,
    volume,
    high: high ?? Math.max(open, close) + 1,
    low: low ?? Math.min(open, close) - 1,
  }
}

/** 평상시 거래량 1,000으로 깔린 진입 전 구간. 종가 80 → 60일선도 80 근처. */
function trailingWithVolume(n = 80, close = 80): PriceBar[] {
  return Array.from({ length: n }, (_, i) =>
    fullBar(`2025-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, {
      open: close, close, volume: 1000, high: close + 1, low: close - 1,
    }),
  )
}

describe('눌림목(pullback) — 대량거래 음봉', () => {
  it('거래량 급증 + 음봉 + 전일 봉 50% 하회면 distribution', () => {
    // 전일 봉: high 102 / low 98 → 중간값 100. 당일 종가 97로 그 아래.
    const bars = [
      fullBar('2026-01-02', { open: 99, close: 101, volume: 1000, high: 102, low: 98 }),
      fullBar('2026-01-05', { open: 101, close: 97, volume: 5000, high: 101, low: 96 }),
    ]
    const sig = findExitSignal(input({
      futureBars: bars, trailingBars: trailingWithVolume(), stop: null, target: null,
    }))
    expect(sig?.date).toBe('2026-01-05')
    expect(sig?.reasons).toContain('distribution')
  })

  it('거래량이 급증해도 양봉이면 신호가 아니다', () => {
    const bars = [
      fullBar('2026-01-02', { open: 99, close: 101, volume: 1000, high: 102, low: 98 }),
      fullBar('2026-01-05', { open: 97, close: 103, volume: 5000, high: 104, low: 96 }),
    ]
    const sig = findExitSignal(input({
      futureBars: bars, trailingBars: trailingWithVolume(), stop: null, target: null,
    }))
    expect(sig?.reasons ?? []).not.toContain('distribution')
  })

  it('음봉이어도 거래량이 평소 수준이면 신호가 아니다', () => {
    const bars = [
      fullBar('2026-01-02', { open: 99, close: 101, volume: 1000, high: 102, low: 98 }),
      fullBar('2026-01-05', { open: 101, close: 97, volume: 1100, high: 101, low: 96 }),
    ]
    const sig = findExitSignal(input({
      futureBars: bars, trailingBars: trailingWithVolume(), stop: null, target: null,
    }))
    expect(sig?.reasons ?? []).not.toContain('distribution')
  })

  it('open/volume이 없는 봉은 판정을 건너뛴다 (데이터 구멍 ≠ 매도 신호)', () => {
    const bars = [bar('2026-01-02', 100), bar('2026-01-05', 97)]
    const sig = findExitSignal(input({ futureBars: bars, stop: null, target: null }))
    expect(sig?.reasons ?? []).not.toContain('distribution')
  })
})

describe('횡보·조정(opportunity) — 가격만 본다', () => {
  /** 3년 고점 대비 크게 빠진 뒤 저점에서 횡보 중인 종목. 60일선은 위에 남는다. */
  function baseBuilding(n = 120): PriceBar[] {
    return Array.from({ length: n }, (_, i) => {
      const close = i < n / 2 ? 10000 - i * 60 : 10000 - Math.floor(n / 2) * 60
      return bar(
        `2025-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
        close,
        close + 50,
        close - 50,
      )
    })
  }

  const trailingBars = baseBuilding()

  it('60일선 아래여도 매도 신호가 아니다 (이 종목들의 정상 상태)', () => {
    const held = [bar('2026-01-02', 6390, 6420, 6360)]
    const sig = findExitSignal(input({
      source: 'opportunity', trailingBars, futureBars: held,
      stop: null, target: null,
      // 하락장 + 주도 섹터 이탈까지 겹쳐도 팔지 않는다
      regimeByDate: { '2026-01-02': 'bear' },
      leadingSectorsByDate: { '2026-01-02': ['Financials'] },
    }))
    expect(sig).toBeNull()
  })

  it('같은 상황에서 눌림목이었다면 즉시 신호가 뜬다 (컨셉 분리의 근거)', () => {
    const held = [bar('2026-01-02', 6390, 6420, 6360)]
    const sig = findExitSignal(input({
      source: 'pullback', trailingBars, futureBars: held,
      stop: null, target: null,
      regimeByDate: { '2026-01-02': 'bear' },
      leadingSectorsByDate: { '2026-01-02': ['Financials'] },
    }))
    expect(sig?.date).toBe('2026-01-02')
    expect(sig?.reasons).toEqual(expect.arrayContaining(['bear', 'sector', 'trend']))
  })

  it('진입 시점 바닥선을 깨면 breakdown', () => {
    // trailing 마지막 60봉의 최저가가 바닥선. 그 아래로 종가가 내려간 날.
    const baseLow = Math.min(...trailingBars.slice(-60).map((b) => b.low))
    const held = [bar('2026-01-02', baseLow - 100, baseLow + 50, baseLow - 150)]
    const sig = findExitSignal(input({
      source: 'opportunity', trailingBars, futureBars: held, stop: null, target: null,
    }))
    expect(sig?.reasons).toEqual(['breakdown'])
  })

  it('바닥선은 진입 시점에 고정된다 — 보유가 길어져도 기준이 따라 내려가지 않는다', () => {
    const baseLow = Math.min(...trailingBars.slice(-60).map((b) => b.low))
    // 바닥선 살짝 위에서 오래 기다가, 마지막 날에 깬다
    const held = [
      ...Array.from({ length: 70 }, (_, i) =>
        bar(`2026-02-${String((i % 28) + 1).padStart(2, '0')}`, baseLow + 20, baseLow + 60, baseLow + 5),
      ),
      bar('2026-06-01', baseLow - 10, baseLow + 10, baseLow - 30),
    ]
    const sig = findExitSignal(input({
      source: 'opportunity', trailingBars, futureBars: held, stop: null, target: null,
    }))
    expect(sig?.date).toBe('2026-06-01')
    expect(sig?.reasons).toEqual(['breakdown'])
  })

  it('손절·목표는 두 컨셉 공통으로 그대로 걸린다', () => {
    const held = [bar('2026-01-02', 6400, 6450, 5000)]
    const sig = findExitSignal(input({
      source: 'opportunity', trailingBars, futureBars: held, stop: 6000, target: null,
    }))
    expect(sig).toEqual({ date: '2026-01-02', price: 6000, reasons: ['stop'] })
  })
})

describe('signalReturnPct', () => {
  it('신호일에 팔았다면의 수익률', () => {
    expect(signalReturnPct(100, { date: 'x', price: 110, reasons: ['bear'] })).toBeCloseTo(10)
    expect(signalReturnPct(100, { date: 'x', price: 90, reasons: ['stop'] })).toBeCloseTo(-10)
  })
})
