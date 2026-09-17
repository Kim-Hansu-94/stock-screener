// 1~4차 분할매수 게이트를 과거로 되돌려 재본다 — "구성종목 조건은 충족했는데
// 490590 자체 조건이 매수를 막은 날이 얼마나 있었나?"를 재는 진단 스크립트.
//
// 배경: `buildTrancheGuide`의 각 차수는 두 조건을 **AND**로 묶는다 —
//   (1) 구성종목 8개의 비중 기준 상승 전환 (구성종목 신호등과 같은 지표)
//   (2) 490590 자체의 차트(20일선 회복·직전 고점 돌파·신고가)
// 490590은 커버드콜 상품이라 콜옵션 매도로 상승분 일부를 넘겨주는 구조다 — 그래서
// 구성종목(NVDA 등)이 신고가를 계속 갱신해도 490590 자체는 옵션 프리미엄 수취 때문에
// 상승폭이 눌려 (2)가 구조적으로 잘 안 뜰 수 있다는 우려가 있었다(2026-09-17 논의).
// **이건 옵션 이론상 일반론이지 490590 실측으로 확인한 게 아니다** — 그래서 잰다.
//
// 방법: 490590의 과거 각 거래일을 하루씩 걸어가며, 그 시점까지의 데이터만으로
// `assessProxyBasket` → `classifyStage` → `buildTrancheGuide`를 그대로 재현한다
// (실제 화면이 오늘 계산하는 것과 완전히 같은 함수). 조건 배열의 인덱스 0이 항상
// 구성종목 비중 조건이고 나머지가 490590 자체 조건이라는 건 `etfEntryCheck.ts`의
// `buildTrancheGuide` 코드 그대로다 — 여기서 새로 정의하지 않는다.
//
// 490590은 정규 유니버스 밖의 감시 종목이라 일봉이 짧다(2026-09-16 기준 476봉 ≈ 2년,
// research/backtestEtfStage.ts 참고) — 표본이 "490590 하나의 2년"뿐이라는 점을
// 결과를 읽을 때 감안할 것.
//
// **2026-09-17 실행 결과, 2·3차에서 실제로 확인됐다** — 구성종목이 이미 신호를 준 날의
// 절반(2차 48%, 3차 50%)을 490590 자체 조건이 막았다(1차는 5%로 문제없었다). 그래서
// `buildTrancheGuide`의 2~4차에서 490590 자체 조건을 뺐다 — 이 스크립트가 그 근거다.
// **지금 다시 돌리면 2~4차의 "490590 자체 조건 충족"이 항상 100%로 나온다** —
// `buildTrancheGuide`의 autoConditions가 이제 구성종목 조건 하나뿐이라 이 스크립트의
// `[proxyCond, ...etfConds]` 파싱이 빈 배열을 만나기 때문이다(4차가 처음부터 그랬던 것과
// 같은 이유, 아래 결과 표 참고). 조건을 또 바꿀 근거가 필요할 때만 다시 다듬을 것.
import { createClient } from '@supabase/supabase-js'
import {
  assessProxyBasket,
  buildTrancheGuide,
  classifyStage,
  ETF_MARKET,
  ETF_TICKER,
  PROXY_TICKERS,
  type ProxyTicker,
} from '../lib/etfEntryCheck.ts'
import type { PriceHistoryRow } from '../lib/types.ts'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_KEY
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY 가 필요합니다.')
  process.exit(1)
}
const db = createClient(url, key)

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Supabase는 한 번에 1,000행까지만 준다. */
async function fetchAll<T>(
  run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const page = 1000
  const out: T[] = []
  for (let from = 0; ; from += page) {
    const { data, error } = await run(from, from + page - 1)
    if (error) throw new Error(`조회 실패: ${describeError(error)}`)
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < page) break
  }
  return out
}

async function fetchBars(market: 'US' | 'KR', tickers: string[]): Promise<Record<string, PriceHistoryRow[]>> {
  const rows = await fetchAll<PriceHistoryRow>((from, to) =>
    db
      .from('stock_price_history')
      .select('ticker, market, date, open, high, low, close, volume')
      .eq('market', market)
      .in('ticker', tickers)
      .order('date', { ascending: true })
      .range(from, to),
  )
  const byTicker: Record<string, PriceHistoryRow[]> = {}
  for (const t of tickers) byTicker[t] = rows.filter((r) => r.ticker === t)
  return byTicker
}

type GateTally = {
  label: string
  n: number
  proxyMet: number
  etfMet: number
  bothMet: number
  /** 구성종목은 충족인데 490590 자체 조건이 막은 날 — 핵심 질문. */
  heldBackByEtf: number
  /** 반대 경우 — 490590 자체는 좋다는데 구성종목이 아직 안 따라온 날. */
  heldBackByProxy: number
}

async function main(): Promise<void> {
  console.log('일봉 조회 중...')
  const [proxyRows, etfRowsByTicker] = await Promise.all([
    fetchBars('US', [...PROXY_TICKERS]),
    fetchBars(ETF_MARKET, [ETF_TICKER]),
  ])
  const etfBars = etfRowsByTicker[ETF_TICKER] ?? []
  console.log(`  490590: ${etfBars.length}봉 (${etfBars[0]?.date ?? '-'} ~ ${etfBars.at(-1)?.date ?? '-'})`)
  for (const t of PROXY_TICKERS) {
    console.log(`  ${t}: ${proxyRows[t]?.length ?? 0}봉`)
  }
  if (etfBars.length === 0) {
    console.error('490590 일봉이 없습니다 — 감시 종목으로 추가돼 있는지, 백필이 됐는지 db_probe로 확인할 것.')
    process.exit(1)
  }

  const tallies: GateTally[] = [1, 2, 3, 4].map((n) => ({
    label: `${n}차`,
    n: 0,
    proxyMet: 0,
    etfMet: 0,
    bothMet: 0,
    heldBackByEtf: 0,
    heldBackByProxy: 0,
  }))

  let evaluatedDays = 0
  for (let i = 0; i < etfBars.length; i++) {
    const asOfDate = etfBars[i].date
    const etfSlice = etfBars.slice(0, i + 1)
    const etfStage = classifyStage(etfSlice)
    if (!etfStage) continue // 66봉 미만 — 아직 판정 불가 구간

    const proxySlice = {} as Record<ProxyTicker, PriceHistoryRow[] | undefined>
    for (const t of PROXY_TICKERS) {
      proxySlice[t] = (proxyRows[t] ?? []).filter((r) => r.date <= asOfDate)
    }
    const proxyAssessment = assessProxyBasket(proxySlice)
    if (proxyAssessment.evaluatedCount === 0) continue // 구성종목 쪽도 데이터가 있어야 비교가 된다

    const tranches = buildTrancheGuide(proxyAssessment, etfStage)
    evaluatedDays += 1

    tranches.forEach((step, idx) => {
      const [proxyCond, ...etfConds] = step.autoConditions
      if (!proxyCond) return
      const proxyMet = proxyCond.met
      const etfMet = etfConds.length === 0 || etfConds.every((c) => c.met)
      const t = tallies[idx]
      t.n += 1
      if (proxyMet) t.proxyMet += 1
      if (etfMet) t.etfMet += 1
      if (proxyMet && etfMet) t.bothMet += 1
      if (proxyMet && !etfMet) t.heldBackByEtf += 1
      if (etfMet && !proxyMet) t.heldBackByProxy += 1
    })
  }

  console.log(`\n판정 가능했던 날: ${evaluatedDays}일 (490590 전체 ${etfBars.length}봉 중)`)
  console.log('='.repeat(90))
  const pct = (a: number, b: number) => (b === 0 ? '   -   ' : `${((a / b) * 100).toFixed(1)}%`.padStart(7))

  for (const t of tallies) {
    console.log(`\n[${t.label}] 판정 가능 ${t.n}일`)
    console.log(`  구성종목 조건 충족                 ${pct(t.proxyMet, t.n)}  (${t.proxyMet}일)`)
    console.log(`  490590 자체 조건 충족              ${pct(t.etfMet, t.n)}  (${t.etfMet}일)`)
    console.log(`  둘 다 충족 (실제 매수 신호)         ${pct(t.bothMet, t.n)}  (${t.bothMet}일)`)
    console.log(
      `  ⚠ 구성종목은 됐는데 490590이 막음    ${pct(t.heldBackByEtf, t.n)}  (${t.heldBackByEtf}일)` +
        (t.proxyMet > 0 ? ` — 구성종목 충족일 중 ${((t.heldBackByEtf / t.proxyMet) * 100).toFixed(0)}%` : ''),
    )
    console.log(
      `     490590은 됐는데 구성종목이 안 따라옴  ${pct(t.heldBackByProxy, t.n)}  (${t.heldBackByProxy}일)`,
    )
  }

  console.log('\n' + '='.repeat(90))
  console.log('※ 490590 하나의 과거 일봉(2년 안팎)으로만 잰 결과다 — 일반 법칙이 아니라')
  console.log('  "이 상품의 이 2년 동안 실제로 이랬다"로 읽을 것. 표본이 짧아 30일 미만 구간의')
  console.log('  비율은 운으로 뒤집힐 수 있다.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
