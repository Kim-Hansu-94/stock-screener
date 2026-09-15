import { describe, expect, it } from 'vitest'
import type { PriceHistoryRow } from './types'
import {
  assessProxyBasket,
  assessStopSignals,
  buildTrancheGuide,
  classifyStage,
  PROXY_TICKERS,
  type ProxyTicker,
} from './etfEntryCheck'

function bars(closes: number[], volumes?: number[]): PriceHistoryRow[] {
  return closes.map((close, i) => ({
    ticker: 'TEST',
    market: 'US',
    date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: volumes ? volumes[i] : 1000,
  }))
}

function linspace(start: number, end: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => start + (i * (end - start)) / (n - 1))
}

/** 66봉(판정 최소치) 미만이면 판정하지 않는다는 걸 보여주는 padding — 값 자체는 무의미. */
const PAD = Array(6).fill(140)

/** 고점·저점이 3구간 연속으로 낮아지는 하락 추세 (A). */
function downtrendCloses(): number[] {
  return [...PAD, ...linspace(140, 131, 20), ...linspace(130, 111, 20), ...linspace(110, 101, 20)]
}

/** 하락하다가 마지막 구간에서 강하게 반등해 상승 전환 조건을 충족하는 흐름 (C). */
function uptrendReversalCloses(): number[] {
  return [...PAD, ...linspace(140, 131, 20), ...linspace(130, 111, 20), ...linspace(113, 136, 20)]
}

/** 추세 없이 좁게 횡보 — 하락도 아니고 상승 전환도 아닌 흐름 (B). */
function sidewaysCloses(): number[] {
  return Array.from({ length: 66 }, (_, i) => (i % 2 === 0 ? 101 : 99))
}

function boostedRecentVolume(n: number, recent = 5): number[] {
  return Array.from({ length: n }, (_, i) => (i >= n - recent ? 2000 : 1000))
}

describe('classifyStage', () => {
  it('일봉이 66개 미만이면 판정하지 않는다', () => {
    expect(classifyStage(bars(linspace(100, 90, 30)))).toBeNull()
  })

  it('고점·저점이 3구간 연속 낮아지면 하락(A)로 판정한다', () => {
    const result = classifyStage(bars(downtrendCloses()))
    expect(result?.stage).toBe('A')
    expect(result?.detail.lowerHighsAndLows).toBe(true)
  })

  it('20일선 회복·고점 돌파·저점 높이기·거래량 증가가 충족되면 상승 전환(C)로 판정한다', () => {
    const closes = uptrendReversalCloses()
    const result = classifyStage(bars(closes, boostedRecentVolume(closes.length)))
    expect(result?.stage).toBe('C')
    expect(result?.detail.aboveSma20).toBe(true)
    expect(result?.detail.higherLow).toBe(true)
    expect(result?.detail.volumeUp).toBe(true)
  })

  it('하락도 상승 전환도 아니면 관찰(B)로 판정한다', () => {
    const result = classifyStage(bars(sidewaysCloses()))
    expect(result?.stage).toBe('B')
  })
})

describe('assessProxyBasket', () => {
  function basket(stages: Record<ProxyTicker, 'A' | 'B' | 'C'>) {
    const closesFor = { A: downtrendCloses(), B: sidewaysCloses(), C: uptrendReversalCloses() }
    const volsFor = (stage: 'A' | 'B' | 'C', n: number) => (stage === 'C' ? boostedRecentVolume(n) : undefined)
    const barsByTicker = {} as Record<ProxyTicker, PriceHistoryRow[]>
    for (const t of PROXY_TICKERS) {
      const stage = stages[t]
      barsByTicker[t] = bars(closesFor[stage], volsFor(stage, closesFor[stage].length))
    }
    return barsByTicker
  }

  it('5개 중 5개가 상승 전환이면 강한 상승 확인(🟢🟢)이다', () => {
    const assessment = assessProxyBasket(basket({ ORCL: 'C', GOOGL: 'C', NVDA: 'C', AMD: 'C', MRVL: 'C' }))
    expect(assessment.cStageCount).toBe(5)
    expect(assessment.evaluatedCount).toBe(5)
    expect(assessment.trafficLight).toBe('🟢🟢')
  })

  it('5개 중 3개가 상승 전환이면 1차 매수 신호등(🟡)이다', () => {
    const assessment = assessProxyBasket(basket({ ORCL: 'C', GOOGL: 'C', NVDA: 'C', AMD: 'B', MRVL: 'A' }))
    expect(assessment.cStageCount).toBe(3)
    expect(assessment.trafficLight).toBe('🟡')
  })

  it('상승 전환이 0~1개면 매수 보류(🔴)이다', () => {
    const assessment = assessProxyBasket(basket({ ORCL: 'A', GOOGL: 'A', NVDA: 'B', AMD: 'A', MRVL: 'B' }))
    expect(assessment.cStageCount).toBe(0)
    expect(assessment.trafficLight).toBe('🔴')
  })

  it('일봉이 없는 종목은 판정 대상에서 빠진다', () => {
    const partial = basket({ ORCL: 'C', GOOGL: 'C', NVDA: 'C', AMD: 'C', MRVL: 'C' })
    partial.MRVL = []
    const assessment = assessProxyBasket(partial)
    expect(assessment.evaluatedCount).toBe(4)
    expect(assessment.cStageCount).toBe(4)
  })
})

describe('buildTrancheGuide', () => {
  it('대장주 2개 상승 전환 + ETF 저점 방어면 1차만 자동 조건 충족', () => {
    const proxy = { perTicker: {} as never, cStageCount: 2, evaluatedCount: 5, trafficLight: '🟠', trafficLabel: '' }
    const etfStage = classifyStage(bars(uptrendReversalCloses(), boostedRecentVolume(66)))
    const steps = buildTrancheGuide(proxy, etfStage, bars(uptrendReversalCloses()))
    expect(steps[0].autoReady).toBe(true)
    expect(steps[1].autoReady).toBe(false)
  })

  it('ETF 자체가 하락 추세(A)면 1차 조건도 자동 충족되지 않는다', () => {
    const proxy = { perTicker: {} as never, cStageCount: 3, evaluatedCount: 5, trafficLight: '🟡', trafficLabel: '' }
    const etfStage = classifyStage(bars(downtrendCloses()))
    const steps = buildTrancheGuide(proxy, etfStage, bars(downtrendCloses()))
    expect(etfStage?.stage).toBe('A')
    expect(steps[0].autoReady).toBe(false)
  })

  it('누적 매수 금액이 500 → 2000 → 3500 → 5000만원으로 쌓인다', () => {
    const proxy = { perTicker: {} as never, cStageCount: 0, evaluatedCount: 5, trafficLight: '🔴', trafficLabel: '' }
    const steps = buildTrancheGuide(proxy, null, [])
    expect(steps.map((s) => s.cumulativeManwon)).toEqual([500, 2000, 3500, 5000])
  })
})

describe('assessStopSignals', () => {
  const noProxy = {} as Record<ProxyTicker, PriceHistoryRow[] | undefined>

  it('490590이 최근 저점보다 더 낮은 저가를 만들면 저점 이탈로 판정한다', () => {
    const closes = [...linspace(100, 90, 40), 80]
    const signals = assessStopSignals(bars(closes), noProxy, null)
    const s = signals.find((x) => x.id === 'etfFreshLow')!
    expect(s.triggered).toBe(true)
  })

  it('저점을 지키고 있으면 저점 이탈이 아니다', () => {
    const closes = [...linspace(90, 100, 40), 101]
    const signals = assessStopSignals(bars(closes), noProxy, null)
    const s = signals.find((x) => x.id === 'etfFreshLow')!
    expect(s.triggered).toBe(false)
  })

  it('10년물 금리가 기준 이상 올랐으면 급등으로 판정한다', () => {
    const signals = assessStopSignals(bars([]), noProxy, { close: 46.5, prevClose: 45.0 })
    const s = signals.find((x) => x.id === 'yieldSpike')!
    expect(s.triggered).toBe(true)
  })

  it('10년물 금리 변동이 작으면 급등이 아니다', () => {
    const signals = assessStopSignals(bars([]), noProxy, { close: 45.2, prevClose: 45.0 })
    const s = signals.find((x) => x.id === 'yieldSpike')!
    expect(s.triggered).toBe(false)
  })

  it('금리 데이터가 없으면 판정 불가로 남긴다', () => {
    const signals = assessStopSignals(bars([]), noProxy, null)
    const s = signals.find((x) => x.id === 'yieldSpike')!
    expect(s.triggered).toBeNull()
  })

  it('뉴스로 직접 판단해야 하는 항목은 계산하지 않고 automatic:false로 남긴다', () => {
    const signals = assessStopSignals(bars([]), noProxy, null)
    const hawkish = signals.find((x) => x.id === 'hawkishFomc')!
    const giveback = signals.find((x) => x.id === 'nasdaqGiveback')!
    expect(hawkish.automatic).toBe(false)
    expect(hawkish.triggered).toBeNull()
    expect(giveback.automatic).toBe(false)
    expect(giveback.triggered).toBeNull()
  })

  it('대장주 3개 이상이 동시에 신저가를 만들면 경고한다', () => {
    const freshLowBars = bars([...linspace(100, 90, 40), 80])
    const okBars = bars([...linspace(90, 100, 40), 101])
    const proxyBars: Record<ProxyTicker, PriceHistoryRow[] | undefined> = {
      ORCL: freshLowBars,
      GOOGL: freshLowBars,
      NVDA: freshLowBars,
      AMD: okBars,
      MRVL: okBars,
    }
    const signals = assessStopSignals(bars([]), proxyBars, null)
    const s = signals.find((x) => x.id === 'proxyFreshLow')!
    expect(s.triggered).toBe(true)
  })
})
