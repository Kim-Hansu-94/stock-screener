import { describe, expect, it } from 'vitest'
import type { PriceHistoryRow } from './types'
import {
  assessProxyBasket,
  assessStopSignals,
  buildTrancheGuide,
  classifyStage,
  describeTenYearYield,
  summarizeStopSignals,
  UPTURN_REQUIRED,
  MANUAL_STOP_CHECKS,
  PROXY_HOLDINGS,
  PROXY_TICKERS,
  type ProxyTicker,
  type StopSignal,
} from './etfEntryCheck'

// 시가를 **전날 종가**로 둔다 — 시가=종가로 만들면 모든 봉이 몸통 0(십자형)이 돼서
// 거래량 방향 판정(buyingVolumeShare)이 통째로 '판정 불가'가 되고, 정작 검증하려는
// 경로를 한 줄도 안 지나간다. 오르는 구간은 양봉, 내리는 구간은 음봉이 된다.
function bars(closes: number[], volumes?: number[]): PriceHistoryRow[] {
  return closes.map((close, i) => ({
    ticker: 'TEST',
    market: 'US',
    date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
    // 고가·저가는 예전 그대로 close±1 — 고점/저점을 보는 다른 조건의 기준을 건드리지
    // 않으려는 것이다. 시가만 전날 대비 방향으로 0.5 옮겨 양봉/음봉을 만든다.
    open: i === 0 || closes[i - 1] === close ? close : closes[i - 1] < close ? close - 0.5 : close + 0.5,
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

  it('20일선 회복·20일선 반등·저점 높이기가 충족되면 상승 전환(C)로 판정한다', () => {
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

  /** 전 종목을 같은 단계로 */
  function allStages(stage: 'A' | 'B' | 'C') {
    return Object.fromEntries(PROXY_HOLDINGS.map((h) => [h.ticker, stage])) as Record<
      ProxyTicker,
      'A' | 'B' | 'C'
    >
  }

  it('전부 상승 전환이면 강한 상승 확인(🟢🟢)이다', () => {
    const assessment = assessProxyBasket(basket(allStages('C')))
    expect(assessment.cStageCount).toBe(PROXY_HOLDINGS.length)
    expect(assessment.cStageWeightShare).toBeCloseTo(1, 6)
    expect(assessment.trafficLight).toBe('🟢🟢')
  })

  it('전부 하락이면 매수 보류(🔴)이다', () => {
    const assessment = assessProxyBasket(basket(allStages('A')))
    expect(assessment.cStageWeightShare).toBe(0)
    expect(assessment.trafficLight).toBe('🔴')
  })

  it('**개수가 아니라 비중으로 센다** — 큰 종목 둘이 작은 종목 셋보다 무겁다', () => {
    // NVDA 14.67 + GOOGL 13.97 = 28.64 (2종목)  vs
    // ANET 5.01 + AMZN 4.65 + META 5.06 = 14.72 (3종목)
    const big = assessProxyBasket(basket({ ...allStages('B'), NVDA: 'C', GOOGL: 'C' }))
    const small = assessProxyBasket(basket({ ...allStages('B'), ANET: 'C', AMZN: 'C', META: 'C' }))
    expect(big.cStageCount).toBe(2)
    expect(small.cStageCount).toBe(3)
    // 종목 수는 적은데 비중은 더 크다 — 개수로 셌다면 반대로 나왔을 자리다.
    expect(big.cStageWeightShare).toBeGreaterThan(small.cStageWeightShare)
  })

  it('일봉이 없는 종목은 분자·분모 양쪽에서 빠진다', () => {
    // "데이터가 없다"와 "안 올랐다"가 구분돼야 한다 — 빠진 종목이 비중을 끌어내리면 안 된다.
    const partial = basket(allStages('C'))
    partial.MRVL = []
    const assessment = assessProxyBasket(partial)
    expect(assessment.evaluatedCount).toBe(PROXY_HOLDINGS.length - 1)
    // 전부 C이므로 판정된 비중은 전부 상승 전환 → 여전히 100%
    expect(assessment.cStageWeightShare).toBeCloseTo(1, 6)
    expect(assessment.evaluatedWeight).toBeCloseTo(
      PROXY_HOLDINGS.reduce((sum, h) => (h.ticker === 'MRVL' ? sum : sum + h.weight), 0),
      6,
    )
  })
})

describe('buildTrancheGuide', () => {
  it('대장주 2개 상승 전환 + ETF 저점 방어면 1차만 자동 조건 충족', () => {
    const proxy = { perTicker: {} as never, cStageCount: 2, evaluatedCount: PROXY_HOLDINGS.length, cStageWeightShare: 0.35, cStageWeight: 0, evaluatedWeight: 100, trafficLight: '🟠', trafficLabel: '' }
    const etfStage = classifyStage(bars(uptrendReversalCloses(), boostedRecentVolume(66)))
    const steps = buildTrancheGuide(proxy, etfStage, bars(uptrendReversalCloses()))
    expect(steps[0].autoReady).toBe(true)
    expect(steps[1].autoReady).toBe(false)
  })

  it('ETF 자체가 하락 추세(A)면 1차 조건도 자동 충족되지 않는다', () => {
    const proxy = { perTicker: {} as never, cStageCount: 3, evaluatedCount: PROXY_HOLDINGS.length, cStageWeightShare: 0.55, cStageWeight: 0, evaluatedWeight: 100, trafficLight: '🟡', trafficLabel: '' }
    const etfStage = classifyStage(bars(downtrendCloses()))
    const steps = buildTrancheGuide(proxy, etfStage, bars(downtrendCloses()))
    expect(etfStage?.stage).toBe('A')
    expect(steps[0].autoReady).toBe(false)
  })

  it('누적 매수 금액이 500 → 2000 → 3500 → 5000만원으로 쌓인다', () => {
    const proxy = { perTicker: {} as never, cStageCount: 0, evaluatedCount: PROXY_HOLDINGS.length, cStageWeightShare: 0, cStageWeight: 0, evaluatedWeight: 100, trafficLight: '🔴', trafficLabel: '' }
    const steps = buildTrancheGuide(proxy, null, [])
    expect(steps.map((s) => s.cumulativeManwon)).toEqual([500, 2000, 3500, 5000])
  })
})

describe('assessStopSignals', () => {
  const noProxy = {} as Record<ProxyTicker, PriceHistoryRow[] | undefined>

  it('490590이 최근 저점보다 더 낮은 저가를 만들면 경고한다', () => {
    const closes = [...linspace(100, 90, 40), 80]
    const signals = assessStopSignals(bars(closes), noProxy, null)
    const s = signals.find((x) => x.id === 'etfFreshLow')!
    expect(s.state).toBe('alert')
    // 문장만 읽어도 뜻이 통해야 한다 — 상태와 제목을 곱해서 읽게 두지 않는다.
    expect(s.headline).toContain('깨고')
  })

  it('저점을 지키고 있으면 이상 없음이고, 문구도 지키는 쪽으로 바뀐다', () => {
    const closes = [...linspace(90, 100, 40), 101]
    const signals = assessStopSignals(bars(closes), noProxy, null)
    const s = signals.find((x) => x.id === 'etfFreshLow')!
    expect(s.state).toBe('ok')
    expect(s.headline).toContain('지키고')
  })

  it('10년물 금리가 기준 이상 올랐으면 경고한다', () => {
    // ^TNX는 퍼센트 값 그대로다(4.65 = 4.65%) — 하루 +0.15%p 이상이면 급등으로 본다.
    const signals = assessStopSignals(bars([]), noProxy, { close: 4.65, prevClose: 4.5 })
    const s = signals.find((x) => x.id === 'yieldSpike')!
    expect(s.state).toBe('alert')
  })

  it('10년물 금리 변동이 작으면 이상 없음이고, %p 대신 직전→최근 값을 보여준다', () => {
    const signals = assessStopSignals(bars([]), noProxy, { close: 4.52, prevClose: 4.5 })
    const s = signals.find((x) => x.id === 'yieldSpike')!
    expect(s.state).toBe('ok')
    // "오늘"이 아니라 "최근" — 미국장 종가는 항상 하루 전 것이다.
    expect(s.detail).toContain('직전 4.50% → 최근 4.52%')
  })

  it('금리 데이터가 없으면 확인 불가로 남긴다', () => {
    const signals = assessStopSignals(bars([]), noProxy, null)
    const s = signals.find((x) => x.id === 'yieldSpike')!
    expect(s.state).toBe('unknown')
  })

  it('뉴스로 직접 판단해야 하는 항목은 자동 판정 목록에 아예 넣지 않는다', () => {
    const signals = assessStopSignals(bars([]), noProxy, null)
    expect(signals.map((s) => s.id)).not.toContain('hawkishFomc')
    expect(signals.map((s) => s.id)).not.toContain('nasdaqGiveback')
    expect(MANUAL_STOP_CHECKS.map((c) => c.id)).toEqual(['nasdaqGiveback', 'hawkishFomc'])
  })

  it('구성종목이 비중 기준으로 한꺼번에 무너지면 경고한다', () => {
    const freshLowBars = bars([...linspace(100, 90, 40), 80])
    const okBars = bars([...linspace(90, 100, 40), 101])
    const proxyBars = Object.fromEntries(
      PROXY_HOLDINGS.map((h) => [h.ticker, okBars]),
    ) as Record<ProxyTicker, PriceHistoryRow[] | undefined>
    // 비중 큰 셋(NVDA 14.67 + GOOGL 13.97 + MRVL 10.46 = 39.1 / 65.32 ≈ 60%)이 동시에 무너지는 경우
    proxyBars.NVDA = freshLowBars
    proxyBars.GOOGL = freshLowBars
    proxyBars.MRVL = freshLowBars
    const signals = assessStopSignals(bars([]), proxyBars, null)
    const s = signals.find((x) => x.id === 'proxyFreshLow')!
    expect(s.state).toBe('alert')
  })
})

describe('summarizeStopSignals', () => {
  function signal(state: 'ok' | 'alert' | 'unknown', headline = '샘플'): StopSignal {
    return { id: `s-${state}-${headline}`, topic: '샘플', state, headline, detail: '' }
  }

  it('경고가 하나라도 있으면 멈추라는 결론을 내고, 어떤 신호인지 문장으로 알려준다', () => {
    const verdict = summarizeStopSignals([
      signal('ok'),
      signal('alert', '490590이 최근 바닥을 깨고 더 내려갔습니다'),
      signal('ok'),
      signal('ok'),
    ])
    expect(verdict.level).toBe('stop')
    expect(verdict.headline).toContain('멈출 때')
    expect(verdict.detail).toContain('490590이 최근 바닥을 깨고 더 내려갔습니다')
  })

  it('전부 이상 없으면 멈출 이유가 없다는 결론을 낸다', () => {
    const verdict = summarizeStopSignals([signal('ok'), signal('ok'), signal('ok'), signal('ok')])
    expect(verdict.level).toBe('clear')
    expect(verdict.detail).toContain('모두 이상 없습니다')
  })

  it('확인 불가가 섞여 있으면 몇 개를 못 봤는지 밝힌다', () => {
    const verdict = summarizeStopSignals([signal('ok'), signal('unknown'), signal('ok'), signal('ok')])
    expect(verdict.level).toBe('clear')
    expect(verdict.detail).toContain('1가지는 데이터가 모자라')
  })
})

describe('상승 전환 조건', () => {
  it('단계와 무관하게 항상 5개를 이름·설명·근거 숫자까지 채운다', () => {
    // 하락 추세(A)여도 "그럼 뭐가 안 맞은 건데?"를 화면이 답할 수 있어야 한다.
    const result = classifyStage(bars(linspace(200, 100, 80)))!
    expect(result.stage).toBe('A')
    expect(result.upturnConditions).toHaveLength(5)
    for (const c of result.upturnConditions) {
      expect(c.label.length).toBeGreaterThan(0)
      expect(c.why.length).toBeGreaterThan(0)
      expect(c.detail.length).toBeGreaterThan(0)
    }
  })

  it('충족 개수는 **세는 조건만** 세고, 기준 이상이면 C단계가 된다', () => {
    const result = classifyStage(bars([...linspace(100, 80, 50), ...linspace(80, 110, 30)]))!
    expect(result.upturnMetCount).toBe(
      result.upturnConditions.filter((c) => c.counted && c.met).length,
    )
    expect(result.stage === 'C').toBe(result.upturnMetCount >= UPTURN_REQUIRED)
  })

  it('**관측 전용 조건은 충족이어도 개수에 안 들어간다** — 빼기로 한 조건이 뒷문으로 다시 세지 않게', () => {
    // 이 표본은 "직전 단기 고점 돌파"(관측 전용)가 충족이다 — 계속 오르는 구간이라서.
    const result = classifyStage(bars([...linspace(100, 80, 50), ...linspace(80, 110, 30)]))!
    const observed = result.upturnConditions.filter((c) => !c.counted)
    expect(observed).toHaveLength(2)
    expect(observed.map((c) => c.label)).toEqual(['직전 단기 고점 돌파', '사는 거래량이 늘어남'])
    expect(observed.some((c) => c.met)).toBe(true)
    // 그런데도 개수는 세는 조건만 센 값이라 전체 met 개수보다 작다.
    expect(result.upturnMetCount).toBeLessThan(result.upturnConditions.filter((c) => c.met).length)
  })

  it('세는 조건이 앞, 관측 전용이 뒤로 온다 (화면이 이 순서를 그대로 쓴다)', () => {
    const result = classifyStage(bars(linspace(200, 100, 80)))!
    const flags = result.upturnConditions.map((c) => c.counted)
    expect(flags).toEqual([true, true, true, false, false])
  })

  it('가격이 1,000 이상이면 콤마 정수로, 미만이면 소수 둘째 자리로 찍는다', () => {
    const kr = classifyStage(bars(linspace(13000, 13500, 80)))!
    expect(kr.upturnConditions[0].detail).toMatch(/종가 1[0-9],[0-9]{3}/)
    const us = classifyStage(bars(linspace(150, 180, 80)))!
    expect(us.upturnConditions[0].detail).toMatch(/종가 1[0-9]{2}\.[0-9]{2}/)
  })
})

describe('describeTenYearYield', () => {
  it('뉴스에 나오는 5.02%를 그대로 넣으면 "높은 편"으로 읽는다 (0.50%가 아니다)', () => {
    const d = describeTenYearYield(5.02)
    expect(d.level).toBe('높은 편')
    expect(d.meaning).toContain('성장주')
  })

  it('구간마다 다른 설명을 준다', () => {
    expect(describeTenYearYield(3.8).level).toBe('보통')
    expect(describeTenYearYield(1.5).level).toBe('낮은 편')
  })
})

describe('거래량 조건은 방향을 본다', () => {
  // 회귀 방지: 예전엔 "5일 평균이 늘었나"만 봐서 **던지느라 터진 거래량**도 매수세로 셌다.
  // pattern_discovery.py가 2026-09-14에 고친 것과 같은 실수였다.
  const rising = [...linspace(100, 80, 50), ...linspace(80, 110, 30)]
  const falling = [...linspace(100, 90, 50), ...linspace(90, 60, 30)]

  /** 마지막 5봉만 거래량을 확 키운다 — '최근 5일 평균 > 그 이전 20일 평균'을 만든다. */
  function spikeAtEnd(n: number): number[] {
    return Array.from({ length: n }, (_, i) => (i >= n - 5 ? 10_000 : 1_000))
  }

  it('오르면서 거래량이 늘면 충족된다', () => {
    const result = classifyStage(bars(rising, spikeAtEnd(rising.length)))!
    expect(result.detail.volumeUp).toBe(true)
  })

  it('떨어지면서 거래량이 늘면 충족되지 않는다 (투매를 매수세로 세지 않는다)', () => {
    const result = classifyStage(bars(falling, spikeAtEnd(falling.length)))!
    expect(result.detail.volumeUp).toBe(false)
    // 화면이 왜 미달인지 설명할 수 있어야 한다 — 비중을 숫자로 남긴다.
    const condition = result.upturnConditions.find((c) => c.label === '사는 거래량이 늘어남')!
    expect(condition.met).toBe(false)
    expect(condition.detail).toMatch(/오른 날 거래량 비중 \d+%/)
  })

  it('거래량이 안 늘었으면 방향과 무관하게 미달이다', () => {
    const flatVolume = Array.from({ length: rising.length }, () => 1_000)
    const result = classifyStage(bars(rising, flatVolume))!
    expect(result.detail.volumeUp).toBe(false)
  })

  it('시가를 종가로 메운 소스는 방향을 알 수 없어 판정 불가로 남긴다', () => {
    // 전 구간 시가=종가면 모든 봉이 몸통 0(십자형)이라, 그대로 두면 **모든 대량거래가
    // 매수 신호**로 잡힌다 — pattern_discovery.py가 같은 이유로 트리거를 끈다.
    const noBody = bars(rising, spikeAtEnd(rising.length)).map((b) => ({ ...b, open: b.close }))
    const result = classifyStage(noBody)!
    expect(result.detail.volumeUp).toBeNull()
    // 판정 불가는 '충족'이 아니다 — 조건 개수에 들어가면 안 된다.
    expect(result.upturnConditions.find((c) => c.label === '사는 거래량이 늘어남')!.met).toBe(false)
  })
})
