/**
 * 490590 매수체크의 A/B/C 판정(`lib/etfEntryCheck.ts`의 `classifyStage`)을 과거로
 * 되돌려 돌려서, **각 조건이 실제로 성과와 같은 방향인지** 재는 리서치 스크립트.
 *
 * 왜 필요한가
 * ----------
 * 490590 판정은 검증된 전략이 아니라 사용자가 정한 경험적 기준이고, 눌림목·저점 매집
 * 후보와 달리 **성적 집계가 없다**. 그래서 조건을 "더 정밀하게" 고쳐도 좋아졌는지 알
 * 방법이 없다. 이 저장소는 이미 그래서 크게 틀린 적이 있다 — 저점 매집 후보 채점에서
 * 거래량 점수가 성과와 **정반대 방향**이었다(pattern_discovery.py docstring v4~v8).
 * 관통하는 교훈: **조건 하나가 "좋은가"가 아니라 성과와 같은 방향으로 가는가를 물으라.**
 *
 * 왜 TypeScript인가
 * ----------------
 * `classifyStage`를 파이썬으로 포팅하면 `opportunityScore.ts` ↔ `watchlist.py`처럼
 * **갈라질 수 있는 동기화 지점이 하나 더 생긴다.** Node 22는 타입만 벗겨내고 .ts를
 * 그대로 실행하므로, 화면이 쓰는 바로 그 함수를 import해서 잰다 — 포팅본이 없다.
 *
 * 표본은 490590 하나로는 턱없이 모자라다(476봉 ≈ 2년, C 전환이 몇 번 안 된다).
 * 그래서 **같은 판정 함수를 미국 유니버스에 돌린다** — 어차피 대장주 5개(오라클·알파벳·
 * 엔비디아·AMD·마벨)를 판정하는 데 쓰는 그 함수라, 그게 쓸모 있는지를 재는 게 된다.
 *
 * 실행: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node research/backtestEtfStage.ts
 * (작업 컨테이너엔 자격증명이 없으므로 .github/workflows/etf_stage_backtest.yml로 돌린다)
 *
 * ⚠️ 읽을 때 주의 — docs/backtest-guide.md의 한계가 여기에도 그대로 적용된다:
 *  - 유니버스가 '오늘 시점' 목록이라 **생존 편향**이 있다. 절대 수치를 믿지 말고
 *    구간끼리의 비교만 볼 것.
 *  - 같은 종목이 STRIDE 간격으로 여러 번 들어가 표본이 서로 독립이 아니다.
 *  - 일봉 보관이 600일이라 기간이 2년 남짓이고 장세 한두 국면만 담긴다.
 */
import { createClient } from '@supabase/supabase-js'
import { classifyStage } from '../lib/etfEntryCheck.ts'
import type { PriceHistoryRow } from '../lib/types.ts'

/**
 * 시총 상위 몇 종목까지 훑을지.
 *
 * **넉넉히 잡아야 한다.** `stock_price_history`에는 유니버스 전체가 아니라 파이프라인이
 * 실제로 받아온 종목(눌림목 스크리닝 대상 + 종목발굴 조정폭 밴드 + 감시 종목)만 있다.
 * 처음에 400으로 돌렸더니 **347개가 일봉 부족으로 빠지고 53종목만 남았다** — 시총
 * 상위 대형주는 대부분 조정폭 밴드(20~60% 하락) 밖이라 일봉을 안 받아오기 때문이다.
 * 일봉이 없는 종목은 조회가 빨리 끝나므로 넓게 훑는 비용이 크지 않다.
 */
const MAX_TICKERS = Number(process.env.MAX_TICKERS) || 2500
/** 같은 종목을 며칠 간격으로 표본에 넣을지 — 겹침을 줄인다(가장 짧은 지평선과 맞춤). */
const STRIDE = 20
/** 진입 뒤 며칠 수익률을 볼지 (거래일). */
const HORIZONS = [20, 60] as const
/** classifyStage가 판정 가능한 최소 봉 수와 같아야 한다. */
const MIN_BARS = 66

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_KEY
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY 가 필요합니다.')
  process.exit(1)
}
const db = createClient(url, key)

/** Supabase 에러 객체는 그냥 String()하면 '[object Object]'가 돼서 사유를 잃는다. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Supabase는 한 번에 1,000행까지만 준다 — 끝까지 받으려면 페이지를 넘겨야 한다. */
async function fetchAll<T>(
  run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const page = 1000
  const out: T[] = []
  for (let from = 0; ; from += page) {
    const { data, error } = await run(from, from + page - 1)
    if (error) throw new Error(`일봉 조회 실패: ${describeError(error)}`)
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < page) break
  }
  return out
}

type Sample = {
  ticker: string
  date: string
  stage: 'A' | 'B' | 'C'
  metCount: number
  /** 조건 이름 → 충족 여부 */
  conditions: Record<string, boolean>
  returns: Record<number, number>
}

function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function pct(x: number): string {
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`
}

/** 표본 묶음 하나의 성적 한 줄. */
function describe(label: string, rows: Sample[], horizon: number): string {
  const rets = rows.map((r) => r.returns[horizon]).filter((r) => Number.isFinite(r))
  if (rets.length === 0) return `  ${label.padEnd(34)} 표본 없음`
  const win = rets.filter((r) => r > 0).length / rets.length
  return (
    `  ${label.padEnd(34)}` +
    `${String(rets.length).padStart(6)}건` +
    `${pct(median(rets)).padStart(10)}(중앙)` +
    `${pct(rets.reduce((a, b) => a + b, 0) / rets.length).padStart(10)}(평균)` +
    `${(win * 100).toFixed(1).padStart(7)}% 승률`
  )
}

async function main(): Promise<void> {
  console.log(`유니버스 조회 중 (US 시총 상위 ${MAX_TICKERS})...`)
  // 유니버스도 페이지로 받는다 — PostgREST가 한 요청당 행 수를 제한해서, limit을 크게
  // 줘도 조용히 잘린다(그러면 "훑었는데 표본이 안 늘었다"가 된다).
  const universe = await fetchAll<{ ticker: string }>((from, to) =>
    db
      .from('stock_universe')
      .select('ticker, market, market_cap')
      .eq('market', 'US')
      .order('market_cap', { ascending: false })
      .range(from, Math.min(to, MAX_TICKERS - 1)),
  )
  const tickers = universe.slice(0, MAX_TICKERS).map((r) => r.ticker)
  console.log(`  ${tickers.length}종목`)

  const samples: Sample[] = []
  let skipped = 0
  const maxHorizon = Math.max(...HORIZONS)

  for (const [i, ticker] of tickers.entries()) {
    if (i % 25 === 0) process.stdout.write(`\r  ${i}/${tickers.length} 진행 · 표본 ${samples.length}건`)
    const bars = await fetchAll<PriceHistoryRow>((from, to) =>
      db
        .from('stock_price_history')
        .select('ticker, market, date, open, high, low, close, volume')
        .eq('market', 'US')
        .eq('ticker', ticker)
        .order('date', { ascending: true })
        .range(from, to),
    )
    if (bars.length < MIN_BARS + maxHorizon + 1) {
      skipped += 1
      continue
    }

    for (let t = MIN_BARS - 1; t < bars.length - maxHorizon; t += STRIDE) {
      const result = classifyStage(bars.slice(0, t + 1))
      if (!result) continue
      const entry = bars[t].close
      if (!(entry > 0)) continue
      const returns: Record<number, number> = {}
      for (const h of HORIZONS) returns[h] = bars[t + h].close / entry - 1
      const conditions: Record<string, boolean> = {}
      for (const c of result.upturnConditions) conditions[c.label] = c.met
      samples.push({
        ticker,
        date: bars[t].date,
        stage: result.stage,
        metCount: result.upturnMetCount,
        conditions,
        returns,
      })
    }
  }
  const contributing = new Set(samples.map((s) => s.ticker)).size
  console.log(
    `\r  완료 · 표본 ${samples.length}건 / **${contributing}종목** ` +
      `(훑은 ${tickers.length}개 중 일봉 부족으로 건너뛴 ${skipped}개)          `,
  )
  if (contributing < 100) {
    console.log(
      `  ⚠️ 기여 종목이 ${contributing}개뿐이다 — 조건별 차이를 결론으로 쓰기엔 얇다.` +
        '\n     stock_price_history에 일봉이 있는 종목 자체가 적다는 뜻이니 MAX_TICKERS를 더 올릴 것.',
    )
  }

  if (samples.length === 0) {
    console.error('표본이 0건입니다 — 일봉이 실제로 들어 있는지 db_probe로 확인할 것.')
    process.exit(1)
  }

  const conditionLabels = Object.keys(samples[0].conditions)

  for (const horizon of HORIZONS) {
    console.log(`\n${'='.repeat(86)}\n보유 ${horizon}거래일\n${'='.repeat(86)}`)

    console.log('\n[1] 단계별 — C(상승 전환)가 정말 나은가')
    for (const stage of ['A', 'B', 'C'] as const) {
      console.log(describe(`${stage}단계`, samples.filter((s) => s.stage === stage), horizon))
    }
    console.log(describe('전체(기준선)', samples, horizon))

    console.log('\n[2] 조건별 — 충족한 쪽이 실제로 더 나은가 (아니면 그 조건이 거꾸로다)')
    for (const label of conditionLabels) {
      const yes = samples.filter((s) => s.conditions[label])
      const no = samples.filter((s) => !s.conditions[label])
      const gap =
        median(yes.map((s) => s.returns[horizon])) - median(no.map((s) => s.returns[horizon]))
      console.log(describe(`${label} 충족`, yes, horizon))
      console.log(describe(`${label} 미달`, no, horizon))
      console.log(`  ${''.padEnd(34)}→ 차이 ${pct(gap)} ${gap > 0 ? '(조건이 성과와 같은 방향)' : '(거꾸로다!)'}`)
    }

    console.log('\n[3] 충족 개수별 — 많을수록 좋아지는가 (단조 증가해야 점수로 쓸 값어치가 있다)')
    for (let n = 0; n <= 5; n++) {
      console.log(describe(`${n}개 충족`, samples.filter((s) => s.metCount === n), horizon))
    }

    console.log('\n[4] "20일선 회복"을 필수로 만들면 나아지는가')
    const sma = conditionLabels.find((l) => l.includes('일선 회복'))!
    const cStage = samples.filter((s) => s.stage === 'C')
    console.log(describe('C단계 전체 (지금 기준)', cStage, horizon))
    console.log(describe('C단계 + 20일선 회복', cStage.filter((s) => s.conditions[sma]), horizon))
    console.log(describe('C단계인데 20일선 아래', cStage.filter((s) => !s.conditions[sma]), horizon))
  }

  console.log(
    '\n※ 생존 편향(상장폐지 종목 빠짐)이 있으므로 절대 수치가 아니라 **구간끼리의 비교**만 볼 것.' +
      `\n  같은 종목이 ${STRIDE}거래일 간격으로 여러 번 들어가 표본이 서로 독립이 아니다.` +
      '\n  표본 30건 미만 칸은 운으로 뒤집히는 범위라 신뢰하지 말 것.',
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
