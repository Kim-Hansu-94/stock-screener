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

/**
 * 일목균형표(일목구름도)의 4개 구성선을 계산한다. 전환선·기준선·선행스팬A·선행스팬B —
 * 시간축 이동(선행스팬 26봉 앞, 후행스팬 26봉 뒤)은 실제 거래일 날짜가 필요해
 * 차트 컴포넌트(StockChart)에서 처리하고, 여기서는 값만 순수 계산한다.
 */
export function ichimokuLines(
  highs: number[],
  lows: number[],
  { tenkanWindow = 9, kijunWindow = 26, senkouBWindow = 52 } = {},
): { tenkan: (number | null)[]; kijun: (number | null)[]; senkouA: (number | null)[]; senkouB: (number | null)[] } {
  const n = highs.length
  const midpoint = (window: number, index: number): number | null => {
    if (index < window - 1) return null
    const highSlice = highs.slice(index - window + 1, index + 1)
    const lowSlice = lows.slice(index - window + 1, index + 1)
    return (Math.max(...highSlice) + Math.min(...lowSlice)) / 2
  }

  const tenkan: (number | null)[] = []
  const kijun: (number | null)[] = []
  const senkouA: (number | null)[] = []
  const senkouB: (number | null)[] = []
  for (let i = 0; i < n; i++) {
    const t = midpoint(tenkanWindow, i)
    const k = midpoint(kijunWindow, i)
    tenkan.push(t)
    kijun.push(k)
    senkouA.push(t !== null && k !== null ? (t + k) / 2 : null)
    senkouB.push(midpoint(senkouBWindow, i))
  }
  return { tenkan, kijun, senkouA, senkouB }
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

/**
 * @param eokDecimals 억원 단위일 때 보여줄 소수 자릿수. 시총처럼 자릿수가 큰 값은
 * 반올림해도 티가 안 나 기본값 0을 쓰고, 부동산 평균가처럼 억 단위 안에서 오르내리는
 * 값은 호출부(formatManwon)에서 1을 넘겨 소수 첫째자리까지 보여준다.
 */
export function formatKrwAmount(krw: number, eokDecimals = 0): string {
  const jo = 1_000_000_000_000
  const eok = 100_000_000
  if (krw >= jo) {
    return `${(krw / jo).toFixed(1)}조원`
  }
  if (krw >= eok) {
    return `${(krw / eok).toFixed(eokDecimals)}억원`
  }
  return `${Math.round(krw).toLocaleString('ko-KR')}원`
}

/** 뉴스 발행 시각 → "3시간 전" 같은 상대 표기. 목록에서 신선도만 가늠하면 되므로 분 단위는 생략한다. */
export function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffH = Math.floor(diffMs / 3_600_000)
  if (diffH < 1) return '방금 전'
  if (diffH < 24) return `${diffH}시간 전`
  const diffD = Math.floor(diffH / 24)
  return `${diffD}일 전`
}
