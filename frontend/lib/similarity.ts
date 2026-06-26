export const VOL_MA_WINDOW = 20
export const MIN_OVERLAP_DAYS = 20
export const RETURN_WEIGHT = 0.8
export const VOLUME_WEIGHT = 0.2

export function zScore(arr: number[]): number[] {
  if (arr.length === 0) return []
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length
  const std = Math.sqrt(variance)
  return std < 0.001 ? arr.map(() => 0) : arr.map((v) => (v - mean) / std)
}

export function stdDev(arr: number[]): number {
  if (arr.length === 0) return 0
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length
  return Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length)
}

export function dailyReturns(prices: number[]): number[] {
  const r: number[] = []
  for (let i = 1; i < prices.length; i++) r.push((prices[i] - prices[i - 1]) / prices[i - 1])
  return r
}

export function normalizeToReturns(prices: number[]): number[] {
  return zScore(dailyReturns(prices))
}

export function normalizeVolume(volumes: number[]): number[] {
  const ratios: number[] = []
  for (let i = VOL_MA_WINDOW; i < volumes.length; i++) {
    const ma = volumes.slice(i - VOL_MA_WINDOW, i).reduce((a, b) => a + b, 0) / VOL_MA_WINDOW
    ratios.push(ma > 0 ? volumes[i] / ma : 1)
  }
  return zScore(ratios)
}

export function cosineSim(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  if (len < MIN_OVERLAP_DAYS) return 0
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    magA += a[i] ** 2
    magB += b[i] ** 2
  }
  if (magA === 0 || magB === 0) return 0
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

export function weightedSim(
  refR: number[],
  refV: number[],
  candR: number[],
  candV: number[],
): number {
  const rSim = cosineSim(refR, candR)
  const vSim =
    refV.length >= MIN_OVERLAP_DAYS && candV.length >= MIN_OVERLAP_DAYS
      ? cosineSim(refV, candV)
      : rSim
  return RETURN_WEIGHT * rSim + VOLUME_WEIGHT * vSim
}

// SMA50 < SMA200 × 0.9 → 심한 역배열
export function isDeepBearish(closes: number[]): boolean {
  if (closes.length < 200) return false
  const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50
  const sma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / 200
  return sma50 < sma200 * 0.9
}

// 최근 20일 std < 직전 60일 std × 0.5 → 변동성 수축
export function hasVolatilityContraction(closes: number[]): boolean {
  if (closes.length < 82) return false
  const ret = dailyReturns(closes)
  const std20 = stdDev(ret.slice(-20))
  const std60 = stdDev(ret.slice(-80, -20))
  return std60 > 0 && std20 < std60 * 0.5
}

// 최근 60일 내 직전 90일 평균 거래량 5배 초과일 2회 이상
export function hasVolumeSpikes(volumes: number[]): boolean {
  const LOOKBACK = 60, BASELINE = 90, THRESHOLD = 5, MIN_SPIKES = 2
  if (volumes.length < LOOKBACK + BASELINE) return false
  const baseline = volumes.slice(-(LOOKBACK + BASELINE), -LOOKBACK)
  const baselineAvg = baseline.reduce((a, b) => a + b, 0) / baseline.length
  if (baselineAvg <= 0) return false
  const spikes = volumes.slice(-LOOKBACK).filter((v) => v >= baselineAvg * THRESHOLD).length
  return spikes >= MIN_SPIKES
}

// 오늘(가장 최근) 거래량이 직전 90일 평균의 N배 이상
export function isVolumeTriggerToday(volumes: number[], multiplier = 3): boolean {
  if (volumes.length < 91) return false
  const baselineAvg = volumes.slice(-91, -1).reduce((a, b) => a + b, 0) / 90
  return baselineAvg > 0 && volumes[volumes.length - 1] >= baselineAvg * multiplier
}
