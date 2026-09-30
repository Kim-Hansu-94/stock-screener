/**
 * 490590 분배금과 배당락일 **실질 등락** 계산 (2026-09-30).
 *
 * 왜 필요한가
 * -----------
 * 490590은 월분배 커버드콜 ETF라 배당락일에 화면 가격이 분배금만큼 빠진다. 화면 등락만 보면
 * 손해로 읽히지만 분배금을 받으니 실제로는 다를 수 있다. 실제 사례(2026-09-29): 전날 종가
 * 14,245원 → 배당락일 종가 14,120원, 화면상 -125원(-0.88%)이지만 분배금 188원을 더하면
 * +63원(+0.44%)이었다. 이 차이를 화면이 대신 계산해 준다.
 *
 * 분배금 값은 **손으로 적은 목록**이다
 * ------------------------------------
 * 자동 수집은 시도했지만 못 찾았다(2026-09-30, 프로브 5차): 네이버는 요약값(최근 1년 합계·
 * 올해 횟수·연 분배율)만 주고 회차별 배당락일·지급일·금액이 없으며, RISE 사이트와 KRX KIND는
 * 490590의 회차별 목록에 닿지 못했다(`pipeline/src/etf_distribution_probe*.py`). 그래서
 * 사용자가 증권사 앱에서 확인한 값을 `DISTRIBUTIONS`에 적는다. **새 분배금이 나오면 이
 * 배열에 한 줄을 더하면 화면이 저절로 따라온다** — 계산은 일봉에서 하므로 다른 곳을 고칠
 * 필요가 없다.
 */

export interface Distribution {
  /** 배당락일(분배락일) — 이날부터 사면 이번 분배금을 못 받는다. 이날 가격에서 분배금이 빠진다. */
  exDate: string
  /** 지급일 — 계좌에 현금이 들어오는 날. 가격에는 영향이 없다. */
  payDate: string
  /** 주당 분배금(세전, 원) */
  amount: number
}

/** 사용자가 증권사 앱에서 확인해 알려 준 값. 최근 것이 아래로 간다. */
export const DISTRIBUTIONS: Distribution[] = [
  { exDate: '2026-09-29', payDate: '2026-10-02', amount: 188 },
]

/**
 * 분배금에 붙는 배당소득세율(15.4% = 소득세 14% + 지방소득세 1.4%).
 * **가정값이다** — 실제 원천징수액은 계좌·과세 구분에 따라 다를 수 있어 화면이
 * "약"이라고 밝힌다. 실제 입금액은 지급일에 증권사 앱에서 확인해야 한다.
 */
export const DISTRIBUTION_TAX_RATE = 0.154

/** 일봉에서 이 계산이 읽는 열만 — 화면용 축소 조회도 그대로 넘길 수 있다. */
export interface CloseBar {
  date: string
  close: number
}

export type ExDateStatus = 'ok' | 'no-bar' | 'no-prev'

export interface ExDateResult {
  distribution: Distribution
  /** ok: 계산됨 / no-bar: 배당락일 일봉이 아직 없음 / no-prev: 그 전날 일봉이 없어 비교 불가 */
  status: ExDateStatus
  prevClose: number | null
  /** 배당락 기준가 = 전날 종가 - 분배금 */
  refPrice: number | null
  close: number | null
  /** 화면에 보이는 등락 = 종가 - 전날 종가 */
  screenChange: number | null
  screenChangePct: number | null
  /** 분배금을 더한 실질 등락 = 종가 + 분배금 - 전날 종가 */
  realChange: number | null
  realChangePct: number | null
  /** 분배금이 전날 종가의 몇 %인가 */
  yieldPct: number | null
  /** 세금을 뗀 분배금(가정 세율) */
  afterTaxAmount: number
  /** 지급일이 기준일(최신 일봉 날짜) 이전이면 paid. 기준일을 모르면 pending으로 둔다. */
  payStatus: 'paid' | 'pending'
}

function pct(part: number, base: number): number {
  return (part / base) * 100
}

/**
 * 분배금마다 배당락일의 화면 등락과 실질 등락을 계산한다.
 *
 * 분모는 둘 다 **전날 종가**로 맞춘다 — 화면 등락률과 같은 분모여야 두 값의 차이가 정확히
 * 분배율(분배금 ÷ 전날 종가)이 된다. 실질 등락을 배당락 기준가로 나누면 0.01%p쯤 달라져
 * "왜 차이가 분배율과 안 맞지"가 된다.
 *
 * `bars`는 날짜 오름차순이어야 한다. 배당락일이 휴장이라 일봉이 없으면 `no-bar`다 —
 * 근처 날짜로 슬쩍 대체하면 다른 날의 등락을 배당락 등락이라고 말하게 된다.
 */
export function analyzeExDates(
  bars: CloseBar[],
  distributions: Distribution[] = DISTRIBUTIONS,
  asOf: string | null = bars.length > 0 ? bars[bars.length - 1].date : null,
): ExDateResult[] {
  return distributions.map((distribution) => {
    const afterTaxAmount = distribution.amount * (1 - DISTRIBUTION_TAX_RATE)
    const payStatus: ExDateResult['payStatus'] =
      asOf !== null && distribution.payDate <= asOf ? 'paid' : 'pending'
    const empty = {
      distribution,
      prevClose: null,
      refPrice: null,
      close: null,
      screenChange: null,
      screenChangePct: null,
      realChange: null,
      realChangePct: null,
      yieldPct: null,
      afterTaxAmount,
      payStatus,
    }

    const idx = bars.findIndex((b) => b.date === distribution.exDate)
    if (idx === -1) return { ...empty, status: 'no-bar' as const }
    if (idx === 0) return { ...empty, status: 'no-prev' as const }

    const prevClose = bars[idx - 1].close
    const close = bars[idx].close
    if (!(prevClose > 0)) return { ...empty, status: 'no-prev' as const }

    const screenChange = close - prevClose
    const realChange = close + distribution.amount - prevClose
    return {
      ...empty,
      status: 'ok' as const,
      prevClose,
      refPrice: prevClose - distribution.amount,
      close,
      screenChange,
      screenChangePct: pct(screenChange, prevClose),
      realChange,
      realChangePct: pct(realChange, prevClose),
      yieldPct: pct(distribution.amount, prevClose),
    }
  })
}

/** 배당락일 하루를 쉬운 말 한 줄로 — 숫자 네 개를 머릿속에서 비교하게 두지 않으려는 것. */
export function describeExDate(r: ExDateResult): string {
  if (r.status === 'no-bar') return '배당락일 일봉이 아직 없어 계산할 수 없습니다.'
  if (r.status === 'no-prev' || r.screenChange === null || r.realChange === null) {
    return '배당락일 전날 일봉이 없어 비교할 수 없습니다.'
  }
  if (r.realChange === 0) return '분배금을 더하면 딱 본전입니다.'
  if (r.realChange > 0) {
    return r.screenChange < 0
      ? '화면에서는 내렸지만, 분배금을 더하면 실제로는 올랐습니다.'
      : '분배금을 받고도 가격이 올랐습니다.'
  }
  return '분배금을 더해도 내렸습니다 — 분배금 때문이 아니라 기초자산이 내린 영향입니다.'
}

export interface DistributionSummary {
  /** 비교의 시작점 — 첫 배당락일 전날 종가 */
  baseClose: number
  baseDate: string
  latestClose: number
  latestDate: string
  /** 계산된 분배금 횟수 */
  count: number
  /** 주당 분배금 합계(세전) */
  totalAmount: number
  totalAmountAfterTax: number
  /** 시작점 대비 가격 변화 */
  priceChange: number
  /** 가격 변화 + 분배금(세전) */
  totalReturn: number
  totalReturnPct: number
  /** 가격 변화 + 세후 분배금 */
  totalReturnAfterTax: number
  totalReturnAfterTaxPct: number
}

/**
 * 첫 배당락일 전날부터 지금까지, 분배금을 더한 총수익.
 *
 * 분배금은 **배당락일 기준으로 센다** — 그날 이전에 사서 들고 있었다면 받을 권리가 생긴
 * 분배금이기 때문이다. 아직 계좌에 안 들어왔어도(지급일 전) 포함하고, 화면이 각 행에
 * '지급 예정'을 따로 적는다.
 *
 * 시작점은 계산에 성공한 첫 분배금의 전날이다. 그 뒤의 분배금 중 하나라도 일봉이 없어
 * 계산하지 못했다면 null을 돌려준다 — 그 분배금만 빠진 합계는 총수익이 실제보다 작게
 * 나오므로, **틀린 합계를 보여주느니 합계를 보여주지 않는 쪽**을 택했다.
 */
export function summarizeDistributions(results: ExDateResult[], bars: CloseBar[]): DistributionSummary | null {
  if (bars.length === 0) return null
  const firstOk = results.findIndex((r) => r.status === 'ok')
  if (firstOk === -1) return null
  if (results.slice(firstOk).some((r) => r.status !== 'ok')) return null

  const counted = results.slice(firstOk)
  const baseClose = counted[0].prevClose
  if (baseClose === null) return null

  const baseIdx = bars.findIndex((b) => b.date === counted[0].distribution.exDate) - 1
  const latest = bars[bars.length - 1]
  const totalAmount = counted.reduce((sum, r) => sum + r.distribution.amount, 0)
  const totalAmountAfterTax = totalAmount * (1 - DISTRIBUTION_TAX_RATE)
  const priceChange = latest.close - baseClose
  const totalReturn = priceChange + totalAmount
  const totalReturnAfterTax = priceChange + totalAmountAfterTax

  return {
    baseClose,
    baseDate: baseIdx >= 0 ? bars[baseIdx].date : counted[0].distribution.exDate,
    latestClose: latest.close,
    latestDate: latest.date,
    count: counted.length,
    totalAmount,
    totalAmountAfterTax,
    priceChange,
    totalReturn,
    totalReturnPct: pct(totalReturn, baseClose),
    totalReturnAfterTax,
    totalReturnAfterTaxPct: pct(totalReturnAfterTax, baseClose),
  }
}
