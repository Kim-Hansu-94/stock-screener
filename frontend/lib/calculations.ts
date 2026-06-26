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
