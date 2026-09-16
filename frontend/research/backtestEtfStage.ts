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
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { createClient } from '@supabase/supabase-js'
import { classifyStage } from '../lib/etfEntryCheck.ts'
import type { PriceHistoryRow } from '../lib/types.ts'

/**
 * 훑을 종목 수 상한 — 사실상 안전장치다(기본값이 일봉 있는 종목 수보다 크다).
 *
 * **대상을 `stock_universe`에서 시총 순으로 고르던 것을 그만뒀다 (2026-09-16).**
 * `stock_price_history`에는 유니버스 전체가 아니라 파이프라인이 실제로 저장하는 종목만
 * 있는데(`pipeline/src/main.py`의 `US_OPP_INDEXES` = S&P500 + NASDAQ100, Russell 3000은
 * 받아와도 메모리에서 패턴 계산만 하고 **저장하지 않는다**), 시총 순으로 고르면 그 집합과
 * 무관한 순서로 뽑게 된다. 실제로 400으로 돌렸을 때 347개가 빠져 **53종목**, 2500으로
 * 올렸을 때도 897개가 빠져 **103종목**밖에 안 남았다 — 상한을 올려도 안 늘어난다는 뜻이다.
 *
 * 지금은 **일봉 테이블에 실제로 들어 있는 종목을 직접 묻는다**(`tickersWithBars`).
 * 있는 걸 다 쓰므로 "훑었는데 표본이 안 늘었다"가 구조적으로 안 생긴다.
 */
const MAX_TICKERS = Number(process.env.MAX_TICKERS) || 5000
/** 같은 종목을 며칠 간격으로 표본에 넣을지 — 겹침을 줄인다(가장 짧은 지평선과 맞춤). */
const STRIDE = 20
/** 진입 뒤 며칠 수익률을 볼지 (거래일). */
const HORIZONS = [20, 60] as const
/** classifyStage가 판정 가능한 최소 봉 수와 같아야 한다. */
const MIN_BARS = 66

/**
 * 일봉을 DB가 아니라 **파일**에서 읽는다 (`pipeline/src/backtest_bars_dump.py`가 만든 NDJSON).
 *
 * `stock_price_history`에는 S&P500+NASDAQ100만 저장돼 있다 — Russell 3000은 본 파이프라인이
 * 매 실행 받아오지만 **Supabase 무료 플랜 500MB** 때문에 저장하지 않는다
 * (`supabase/index_slimdown.sql`: 이미 426MB를 쓰고 있었고 일봉 인덱스 하나가 146MB).
 * 그래서 백테스트만은 DB를 늘리지 않고 그때그때 받아서 파일로 읽는다.
 */
const BARS_FILE = process.env.BARS_FILE

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_KEY
if (!BARS_FILE && (!url || !key)) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY 또는 BARS_FILE 이 필요합니다.')
  process.exit(1)
}
const db = createClient(url ?? 'https://unused.supabase.co', key ?? 'unused')

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
  /**
   * 조건 5개를 다 세던 **옛 기준**(5개 중 3개)으로 매긴 단계.
   *
   * 조건 둘을 판정에서 뺀 뒤(2026-09-16), "빼서 정말 나아졌나"를 **같은 표본에서**
   * 나란히 봐야 답이 나온다 — 옛 결과와 새 결과를 다른 실행끼리 비교하면 표본이
   * 달라져서 무엇 때문에 달라진 건지 알 수 없다.
   */
  oldStage: 'A' | 'B' | 'C'
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

/** 그 시장에서 `on` 이하로 가장 가까운 실제 거래일 — 달력 날짜는 휴장일일 수 있다. */
async function nearestTradingDate(on: string): Promise<string | null> {
  const { data, error } = await db
    .from('stock_price_history')
    .select('date')
    .eq('market', 'US')
    .lte('date', on)
    .order('date', { ascending: false })
    .limit(1)
  if (error) throw new Error(`거래일 조회 실패: ${describeError(error)}`)
  return data?.[0]?.date ?? null
}

/**
 * **일봉이 실제로 들어 있는 종목**을 테이블에 직접 묻는다.
 *
 * PostgREST에 DISTINCT가 없어서 전체 행을 훑을 수는 없고(종목당 600봉이라 수십만 행),
 * **여러 시점의 하루치**를 뽑아 합집합을 만든다. 하루만 보면 그날 이후 수집이 끊긴 종목이
 * 통째로 빠지므로, 보관 구간(600일)에 걸쳐 앵커를 여러 개 둔다.
 */
async function tickersWithBars(): Promise<string[]> {
  const latest = await nearestTradingDate(new Date().toISOString().slice(0, 10))
  if (!latest) return []
  const anchors: string[] = []
  for (const back of [0, 100, 200, 300, 400, 500]) {
    const d = new Date(`${latest}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - back)
    const hit = await nearestTradingDate(d.toISOString().slice(0, 10))
    if (hit && !anchors.includes(hit)) anchors.push(hit)
  }
  const found = new Set<string>()
  for (const day of anchors) {
    const rows = await fetchAll<{ ticker: string }>((from, to) =>
      db
        .from('stock_price_history')
        .select('ticker')
        .eq('market', 'US')
        .eq('date', day)
        .range(from, to),
    )
    for (const r of rows) found.add(r.ticker)
    console.log(`  ${day}: ${rows.length}종목 (누적 ${found.size})`)
  }
  return [...found]
}

type TickerBars = { ticker: string; bars: PriceHistoryRow[] }
/** NDJSON 한 줄의 bars 배열 — date, open, high, low, close, volume 순서 (덤프 스크립트와 약속). */
type DumpRow = [string, number, number, number, number, number]

/**
 * 파일에서 한 종목씩 흘려보낸다 — 통째로 배열에 담으면 수천 종목 × 수백 봉이 한꺼번에
 * 메모리에 올라간다. NDJSON을 쓴 이유도 이것이다(한 줄이 한 종목).
 */
async function* barsFromFile(path: string): AsyncGenerator<TickerBars> {
  const rl = createInterface({ input: createReadStream(path, 'utf-8'), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    const rec = JSON.parse(line) as { ticker: string; bars: DumpRow[] }
    yield {
      ticker: rec.ticker,
      bars: rec.bars.map(([date, open, high, low, close, volume]) => ({
        ticker: rec.ticker,
        market: 'US',
        date,
        open,
        high,
        low,
        close,
        volume,
      })) as PriceHistoryRow[],
    }
  }
}

async function* barsFromDb(tickers: string[]): AsyncGenerator<TickerBars> {
  for (const ticker of tickers) {
    const bars = await fetchAll<PriceHistoryRow>((from, to) =>
      db
        .from('stock_price_history')
        .select('ticker, market, date, open, high, low, close, volume')
        .eq('market', 'US')
        .eq('ticker', ticker)
        .order('date', { ascending: true })
        .range(from, to),
    )
    yield { ticker, bars }
  }
}

async function main(): Promise<void> {
  let source: AsyncGenerator<TickerBars>
  let scanned = 0
  if (BARS_FILE) {
    console.log(`일봉을 파일에서 읽는다: ${BARS_FILE}`)
    source = barsFromFile(BARS_FILE)
  } else {
    // 진단용으로 유니버스 크기도 같이 찍는다 — "유니버스엔 3,000개인데 일봉은 600개"처럼
    // 어디서 줄어드는지를 숫자로 봐야 다음에 뭘 고칠지가 정해진다.
    const universe = await fetchAll<{ ticker: string }>((from, to) =>
      db.from('stock_universe').select('ticker').eq('market', 'US').range(from, to),
    )
    console.log(`stock_universe US: ${universe.length}종목`)

    console.log('일봉이 실제로 있는 종목 조회 중...')
    const withBars = await tickersWithBars()
    const tickers = withBars.slice(0, MAX_TICKERS)
    console.log(`  → 일봉 보유 ${withBars.length}종목 (이 중 ${tickers.length}개를 훑는다)`)
    source = barsFromDb(tickers)
  }

  const samples: Sample[] = []
  let skipped = 0
  const maxHorizon = Math.max(...HORIZONS)

  for await (const { ticker, bars } of source) {
    if (scanned % 100 === 0) process.stdout.write(`\r  ${scanned}종목 훑음 · 표본 ${samples.length}건`)
    scanned += 1
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
      // 옛 기준 재현: 하락 추세면 A, 아니면 **조건 5개 전부**를 세서 3개 이상이면 C.
      const allMet = result.upturnConditions.filter((c) => c.met).length
      const oldStage: 'A' | 'B' | 'C' = result.detail.lowerHighsAndLows
        ? 'A'
        : allMet >= 3
          ? 'C'
          : 'B'
      samples.push({
        ticker,
        date: bars[t].date,
        stage: result.stage,
        oldStage,
        metCount: result.upturnMetCount,
        conditions,
        returns,
      })
    }
  }
  const contributing = new Set(samples.map((s) => s.ticker)).size
  console.log(
    `\r  완료 · 표본 ${samples.length}건 / **${contributing}종목** ` +
      `(훑은 ${scanned}개 중 일봉 부족으로 건너뛴 ${skipped}개)          `,
  )
  if (contributing < 300) {
    console.log(
      `  ⚠️ 기여 종목이 ${contributing}개뿐이다 — 조건별 차이를 결론으로 쓰기엔 얇다.` +
        '\n     대상은 이미 "일봉이 있는 종목 전부"라 MAX_TICKERS를 올려도 안 늘어난다.' +
        '\n     늘리려면 파이프라인이 일봉을 저장하는 범위(main.py의 US_OPP_INDEXES)를 넓혀야 한다.',
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

    console.log('\n[5] 옛 기준(조건 5개 중 3개) vs 새 기준(세는 3개 중 2개) — 빼서 나아졌나')
    for (const stage of ['A', 'B', 'C'] as const) {
      console.log(describe(`옛 기준 ${stage}단계`, samples.filter((s) => s.oldStage === stage), horizon))
      console.log(describe(`새 기준 ${stage}단계`, samples.filter((s) => s.stage === stage), horizon))
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
