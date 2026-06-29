export function calculateChangePercent(closesAscending: number[]): number | null {
  if (closesAscending.length < 2) return null

  const previous = closesAscending[closesAscending.length - 2]
  const latest = closesAscending[closesAscending.length - 1]

  if (previous === 0) return null

  return ((latest - previous) / previous) * 100
}

export function simpleMovingAverage(valuesAscending: number[], window: number): (number | null)[] {
  return valuesAscending.map((_, index) => {
    if (index < window - 1) return null

    const slice = valuesAscending.slice(index - window + 1, index + 1)
    const sum = slice.reduce((total, value) => total + value, 0)
    return sum / window
  })
}

export function bollingerBands(
  values: number[],
  window: number = 20,
  multiplier: number = 2,
): { upper: number | null; middle: number | null; lower: number | null }[] {
  return values.map((_, index) => {
    if (index < window - 1) return { upper: null, middle: null, lower: null }
    const slice = values.slice(index - window + 1, index + 1)
    const mean = slice.reduce((sum, v) => sum + v, 0) / window
    const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / window
    const stdDev = Math.sqrt(variance)
    return {
      upper: mean + multiplier * stdDev,
      middle: mean,
      lower: mean - multiplier * stdDev,
    }
  })
}

export function relativeStrengthIndex(values: number[], window: number = 14): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null)
  if (values.length < window + 1) return result

  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= window; i++) {
    const change = values[i] - values[i - 1]
    if (change > 0) avgGain += change
    else avgLoss += -change
  }
  avgGain /= window
  avgLoss /= window

  result[window] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)

  for (let i = window + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1]
    avgGain = (avgGain * (window - 1) + (change > 0 ? change : 0)) / window
    avgLoss = (avgLoss * (window - 1) + (change < 0 ? -change : 0)) / window
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }

  return result
}

export function formatKrwAmount(krw: number): string {
  const jo = 1_000_000_000_000
  const eok = 100_000_000
  if (krw >= jo) {
    return `${(krw / jo).toFixed(1)}조원`
  }
  if (krw >= eok) {
    return `${Math.round(krw / eok)}억원`
  }
  return `${Math.round(krw).toLocaleString('ko-KR')}원`
}
