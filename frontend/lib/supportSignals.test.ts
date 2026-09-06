import { describe, expect, it } from 'vitest'
import {
  MA_WINDOW,
  assessSupportSignals,
  drawdownFromHigh,
  profitLossPct,
  type SupportSignalId,
} from './supportSignals'
import type { PriceHistoryRow } from './types'

/** 오름차순 일봉을 만든다. close만 주면 high/low는 ±1%, volume은 기본값으로 채운다. */
function bars(
  closes: number[],
  over: { lows?: number[]; highs?: number[]; volumes?: number[] } = {},
): PriceHistoryRow[] {
  return closes.map((close, i) => ({
    ticker: '000660',
    market: 'KR' as const,
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: close,
    high: over.highs?.[i] ?? close * 1.01,
    low: over.lows?.[i] ?? close * 0.99,
    close,
    volume: over.volumes?.[i] ?? 1000,
  }))
}

function signal(rows: PriceHistoryRow[], id: SupportSignalId) {
  const found = assessSupportSignals(rows).signals.find((s) => s.id === id)
  if (!found) throw new Error(`signal ${id} not found`)
  return found
}

/** 120일선·일목구름까지 계산되려면 최소 120 + 26봉이 필요하다. */
const LONG = 200

describe('assessSupportSignals', () => {
  it('returns nothing for an empty history', () => {
    const result = assessSupportSignals([])
    expect(result.signals).toEqual([])
    expect(result.evaluatedCount).toBe(0)
  })

  it('marks conditions as 판정 불가(null) instead of 미충족 when bars are missing', () => {
    // 30봉이면 120일선·구름은 계산이 안 된다 — 이걸 false로 두면 "조건 미달"로
    // 보여 사용자가 오해한다.
    const short = bars(Array.from({ length: 30 }, () => 100))
    expect(signal(short, 'nearMa').met).toBeNull()
    expect(signal(short, 'cloud').met).toBeNull()

    const result = assessSupportSignals(short)
    expect(result.evaluatedCount).toBeLessThan(5)
    expect(result.metCount).toBeLessThanOrEqual(result.evaluatedCount)
  })

  // ── 120일선 근접 ──────────────────────────────────────────────────────
  it('flags 120일선 근접 when price sits within ±5% of the moving average', () => {
    const flat = bars(Array.from({ length: LONG }, () => 100))
    const s = signal(flat, 'nearMa')
    expect(s.met).toBe(true)
    expect(s.detail).toContain(`${MA_WINDOW}일선 대비`)
  })

  it('does not flag 120일선 근접 when price is far above the average', () => {
    // 마지막 봉만 크게 띄우면 120일 평균과 크게 벌어진다.
    const closes = Array.from({ length: LONG }, () => 100)
    closes[closes.length - 1] = 130
    expect(signal(bars(closes), 'nearMa').met).toBe(false)
  })

  // ── 일목구름 ────────────────────────────────────────────────────────
  it('treats price above the cloud as supported', () => {
    // 꾸준한 상승 추세면 현재가가 26봉 전 구름 위에 있다.
    const closes = Array.from({ length: LONG }, (_, i) => 100 + i)
    const s = signal(bars(closes), 'cloud')
    expect(s.met).toBe(true)
    expect(s.detail).toContain('구름 위')
  })

  it('marks a break below the cloud as 미충족', () => {
    // 계속 하락하면 현재가가 26봉 전 구름(그때는 훨씬 높았다) 아래로 내려간다.
    const closes = Array.from({ length: LONG }, (_, i) => 500 - i)
    const s = signal(bars(closes), 'cloud')
    expect(s.met).toBe(false)
    expect(s.detail).toContain('구름 아래로 이탈')
  })

  it('uses the cloud shifted back 26 bars, not the not-yet-arrived cloud at the last index', () => {
    // 마지막 26봉에서만 급등시키면, 그 급등이 아직 구름에 반영되기 전이라
    // (26봉 이동 때문에) 현재가는 구름 위로 판정돼야 한다.
    const closes = Array.from({ length: LONG }, (_, i) => (i < LONG - 26 ? 100 : 200))
    expect(signal(bars(closes), 'cloud').met).toBe(true)
  })

  // ── RSI 과매도 후 반등 ────────────────────────────────────────────────
  it('flags RSI bounce when an oversold reading is followed by a recovery', () => {
    // 길게 하락시켜 RSI를 30 아래로 떨어뜨린 뒤, 마지막 며칠만 반등시킨다.
    const closes = [
      ...Array.from({ length: LONG - 5 }, (_, i) => 500 - i * 2),
      ...[1, 2, 3, 4, 5].map((n) => 500 - (LONG - 5) * 2 + n * 8),
    ]
    const s = signal(bars(closes), 'rsiBounce')
    expect(s.met).toBe(true)
    expect(s.detail).toContain('RSI')
  })

  it('does not flag RSI bounce while the stock is still making new lows', () => {
    const closes = Array.from({ length: LONG }, (_, i) => 500 - i * 2)
    // 계속 신저가 = RSI가 최저치에 붙어 있어 "그 바닥보다 올라와 있다"가 성립 안 함
    expect(signal(bars(closes), 'rsiBounce').met).toBe(false)
  })

  it('does not flag RSI bounce when the stock never got oversold', () => {
    const closes = Array.from({ length: LONG }, () => 100)
    // 횡보만 하면 RSI가 기준선 아래로 간 적이 없다
    expect(signal(bars(closes), 'rsiBounce').met).toBe(false)
  })

  it('counts an RSI dip into the 30~35 band as oversold (기준 30 → 35 완화)', () => {
    // 교과서 기준 30을 쓰면 대형주가 실제로 눌린 구간을 계속 놓친다는 요청으로
    // 35로 완화했다(2026-09-06). 이 픽스처는 RSI 최저가 34.3까지만 내려가므로
    // 기준이 30이면 미충족, 35면 충족이다 — 임계값이 되돌아가면 여기서 깨진다.
    const closes = [
      ...Array.from({ length: 180 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1)),
      ...Array.from({ length: 8 }, () => 0), // 아래에서 채운다
    ]
    for (let i = 180; i < 188; i++) closes[i] = closes[i - 1] - 1
    closes.push(closes[closes.length - 1] + 0.8, closes[closes.length - 1] + 1.6)

    const s = signal(bars(closes), 'rsiBounce')
    expect(s.met).toBe(true)
    expect(s.detail).toContain('기준 35 이하')
  })

  // ── 저점 높이기 ──────────────────────────────────────────────────────
  it('flags 저점 높이기 when the recent 20-day low is above the prior one', () => {
    const lows = [...Array.from({ length: LONG - 20 }, () => 50), ...Array.from({ length: 20 }, () => 70)]
    expect(signal(bars(Array.from({ length: LONG }, () => 100), { lows }), 'higherLow').met).toBe(true)
  })

  it('does not flag 저점 높이기 when the stock keeps making lower lows', () => {
    const lows = [...Array.from({ length: LONG - 20 }, () => 70), ...Array.from({ length: 20 }, () => 50)]
    expect(signal(bars(Array.from({ length: LONG }, () => 100), { lows }), 'higherLow').met).toBe(false)
  })

  // ── 거래량 실린 상승 ──────────────────────────────────────────────────
  it('flags 거래량 실린 상승 only when volume AND price both rise', () => {
    const closes = [...Array.from({ length: LONG - 5 }, () => 100), 102, 104, 106, 108, 110]
    const volumes = [...Array.from({ length: LONG - 5 }, () => 1000), ...Array.from({ length: 5 }, () => 3000)]
    expect(signal(bars(closes, { volumes }), 'volumeRise').met).toBe(true)
  })

  it('does not flag 거래량 실린 상승 when volume spikes on a falling price (투매)', () => {
    const closes = [...Array.from({ length: LONG - 5 }, () => 100), 98, 96, 94, 92, 90]
    const volumes = [...Array.from({ length: LONG - 5 }, () => 1000), ...Array.from({ length: 5 }, () => 3000)]
    expect(signal(bars(closes, { volumes }), 'volumeRise').met).toBe(false)
  })

  it('does not flag 거래량 실린 상승 when price rises on shrinking volume', () => {
    const closes = [...Array.from({ length: LONG - 5 }, () => 100), 102, 104, 106, 108, 110]
    const volumes = [...Array.from({ length: LONG - 5 }, () => 3000), ...Array.from({ length: 5 }, () => 500)]
    expect(signal(bars(closes, { volumes }), 'volumeRise').met).toBe(false)
  })

  it('counts only evaluated conditions in the denominator', () => {
    const result = assessSupportSignals(bars(Array.from({ length: LONG }, () => 100)))
    expect(result.evaluatedCount).toBe(5)
    expect(result.metCount).toBe(result.signals.filter((s) => s.met === true).length)
  })
})

describe('profitLossPct', () => {
  it('returns the loss percentage against the average cost', () => {
    expect(profitLossPct(2_160_000, 1_660_000)).toBeCloseTo(-23.15, 1)
  })

  it('returns a positive number when in profit', () => {
    expect(profitLossPct(1_000, 1_250)).toBeCloseTo(25, 5)
  })

  it('returns null without a usable average cost', () => {
    expect(profitLossPct(null, 100)).toBeNull()
    expect(profitLossPct(undefined, 100)).toBeNull()
    expect(profitLossPct(0, 100)).toBeNull()
  })
})

describe('drawdownFromHigh', () => {
  it('measures how far the close sits below the highest high', () => {
    expect(drawdownFromHigh(bars([100, 200, 150], { highs: [100, 200, 150] }))).toBeCloseTo(-25, 5)
  })

  it('returns null with no bars', () => {
    expect(drawdownFromHigh([])).toBeNull()
  })
})
