/**
 * 포지션 관리 카드의 **지지신호 5개를 과거로 되돌려 재는 리서치 스크립트**.
 *
 * 왜 필요한가
 * -----------
 * 지지신호는 성적 집계가 없다(눌림목은 scorecard.ts, 저점 매집 후보는 patternScorecard.ts로
 * 재지만 포지션 관리 카드는 재는 데가 없다). 그래서 "조건이 이상해 보인다"는 느낌만으로
 * 고치면 좋아졌는지 알 방법이 없다 — 이 저장소는 그걸로 두 번 데였다:
 *
 *   - `pattern_discovery.py` (2026-09-14): 거래량 점수가 성과와 **정반대 방향**이었다.
 *   - `research/backtestEtfStage.ts` (2026-09-16): 조건 2개를 뺄 뻔했다가, 시장 효과를
 *     빼고 다시 재니 **우위가 있는 조건이 하나도 없어서** 되돌렸다.
 *
 * 그래서 조건을 손대기 전에 이걸로 잰다. **파이썬으로 포팅하지 않는다** — 화면이 쓰는
 * `assessSupportSignals`를 그대로 import한다(backtestEtfStage.ts와 같은 원칙).
 *
 * 무엇을 재는가
 * -------------
 * 각 거래일마다 그 시점까지의 일봉만으로 5개 신호를 판정하고, 그 뒤 20·60거래일
 * 수익률을 본다. 조건이 쓸모 있다면 **충족한 날의 성과가 미충족한 날보다 좋아야** 한다.
 *
 * **시장 효과를 반드시 뺀다.** 표본 기간이 강세장이면 많이 빠진 종목이 크게 되튀어
 * "하락 중일 때 사면 좋다"로 찍힌다(backtestEtfStage.ts가 실제로 그렇게 속았다).
 * 날짜별로 그날 표본 전체의 중앙값을 빼면 그 효과가 사라진다.
 *
 * **그리고 '물타기 상황'만 따로 본다.** 이 카드는 이미 물린 종목에 추가 매수를
 * 고민할 때 보는 것이라, 전체 표본의 평균보다 **이미 깊이 빠진 종목**에서의 성적이
 * 실제 쓰임에 맞는다.
 *
 * 표본 건수에 속지 말 것
 * ----------------------
 * 건수는 종목 수 × 샘플 간격이고, 60일 성과를 짧은 간격으로 보면 **연속한 표본이
 * 서로 겹친다**. 믿을 숫자는 건수가 아니라 종목 수다 — 그래서 둘 다 찍는다.
 *
 * 실행: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
 *       node --import ./research/resolveTsImports.mjs research/backtestSupportSignals.ts
 */

import { createClient } from '@supabase/supabase-js'
import { assessSupportSignals, type SupportSignalId } from '../lib/supportSignals.ts'
import type { PriceHistoryRow } from '../lib/types.ts'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_KEY
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY 가 필요합니다.')
  process.exit(1)
}
const db = createClient(url, key)

const MARKET = (process.env.MARKET ?? 'KR') as 'KR' | 'US'
/** 샘플 간격(거래일). 촘촘하게 보면 표본이 늘지만 서로 겹친다. */
const STEP = Number(process.env.STEP ?? 10)
/**
 * 판정에 필요한 최소 일봉. 120일선이 **정확히 120봉**에서야 처음 값이 나오므로
 * 여유를 둔다 — 화면이 쓰는 180일 창이 실측 120봉이었던 것과 같은 함정이다.
 */
const MIN_BARS = Number(process.env.MIN_BARS ?? 140)
/** '물타기 상황' 판정 — 최근 120봉 고점 대비 이만큼(%) 이상 빠져 있을 때. */
const DRAWDOWN_CUT = Number(process.env.DRAWDOWN_CUT ?? 20)
const HORIZONS = [20, 60]
const PAGE = 1000

const SIGNAL_IDS: SupportSignalId[] = ['nearMa', 'cloud', 'rsiBounce', 'higherLow', 'volumeRise']
const LABELS: Record<SupportSignalId, string> = {
  nearMa: '120일선 근접',
  cloud: '일목구름 지지',
  rsiBounce: 'RSI 과매도 후 반등',
  higherLow: '저점 높이기',
  volumeRise: '거래량 실린 상승',
}

async function fetchAll<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return out
}

const median = (xs: number[]) => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const pct = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—')

/** 한 관측 = 한 종목의 한 시점. */
interface Obs {
  ticker: string
  date: string
  met: Partial<Record<SupportSignalId, boolean>>
  metCount: number
  drawdownPct: number
  fwd: Record<number, number>
  /** 시장 효과를 뺀 수익률 — 날짜별 중앙값을 뺀 값 */
  adj: Record<number, number>
}

async function nearestTradingDate(on: string): Promise<string | null> {
  const { data, error } = await db
    .from('stock_price_history')
    .select('date')
    .eq('market', MARKET)
    .lte('date', on)
    .order('date', { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  return data?.[0]?.date ?? null
}

/** 일봉이 실제로 들어 있는 종목 — 여러 시점의 하루치 합집합 (backtestEtfStage와 같은 방식). */
async function tickersWithBars(): Promise<string[]> {
  const latest = await nearestTradingDate(new Date().toISOString().slice(0, 10))
  if (!latest) return []
  const anchors: string[] = []
  for (const back of [0, 120, 240, 360, 480]) {
    const d = new Date(`${latest}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - back)
    const hit = await nearestTradingDate(d.toISOString().slice(0, 10))
    if (hit && !anchors.includes(hit)) anchors.push(hit)
  }
  const found = new Set<string>()
  for (const day of anchors) {
    const rows = await fetchAll<{ ticker: string }>((from, to) =>
      db.from('stock_price_history').select('ticker').eq('market', MARKET).eq('date', day).range(from, to),
    )
    for (const r of rows) found.add(r.ticker)
    console.log(`  ${day}: ${rows.length}종목 (누적 ${found.size})`)
  }
  return [...found]
}

function report(label: string, rows: number[]): string {
  if (rows.length === 0) return `    ${label.padEnd(22)} 표본 없음`
  const win = (rows.filter((r) => r > 0).length / rows.length) * 100
  return (
    `    ${label.padEnd(22)}${String(rows.length).padStart(7)}건` +
    `${pct(median(rows)).padStart(10)}(중앙)` +
    `${pct(mean(rows)).padStart(10)}(평균)` +
    `${win.toFixed(1).padStart(7)}% 승률`
  )
}

function analyze(title: string, obs: Obs[]) {
  console.log(`\n${'='.repeat(78)}`)
  console.log(`${title}`)
  const tickers = new Set(obs.map((o) => o.ticker))
  console.log(`표본 ${obs.length}건 · ${tickers.size}종목 (믿을 숫자는 종목 수다)`)
  if (obs.length === 0) return

  for (const h of HORIZONS) {
    console.log(`\n── ${h}거래일 뒤 ──`)
    console.log('  [원수익 — 장세가 섞여 있다]')
    for (const id of SIGNAL_IDS) {
      const metRows = obs.filter((o) => o.met[id] === true).map((o) => o.fwd[h])
      const unmetRows = obs.filter((o) => o.met[id] === false).map((o) => o.fwd[h])
      console.log(`  ${LABELS[id]}`)
      console.log(report('충족', metRows))
      console.log(report('미충족', unmetRows))
      if (metRows.length && unmetRows.length) {
        console.log(`      → 차이(중앙) ${pct(median(metRows) - median(unmetRows))}`)
      }
    }
    console.log('\n  [시장 효과 제거 — 날짜별 중앙값을 뺀 값. 이게 진짜 우위다]')
    for (const id of SIGNAL_IDS) {
      const metRows = obs.filter((o) => o.met[id] === true).map((o) => o.adj[h])
      const unmetRows = obs.filter((o) => o.met[id] === false).map((o) => o.adj[h])
      const diff =
        metRows.length && unmetRows.length ? median(metRows) - median(unmetRows) : NaN
      console.log(
        `  ${LABELS[id].padEnd(20)} 충족 ${String(metRows.length).padStart(6)}건 ${pct(median(metRows)).padStart(8)} · ` +
          `미충족 ${String(unmetRows.length).padStart(6)}건 ${pct(median(unmetRows)).padStart(8)} · 차이 ${pct(diff).padStart(8)}`,
      )
    }
    console.log('\n  [충족 개수별 — 많을수록 좋아야 "개수를 세는 것"이 의미가 있다]')
    for (let n = 0; n <= 5; n += 1) {
      const rows = obs.filter((o) => o.metCount === n).map((o) => o.adj[h])
      console.log(report(`${n}개 충족`, rows))
    }
  }
}

async function main() {
  console.log(`시장 ${MARKET} · 샘플 간격 ${STEP}거래일 · 최소 ${MIN_BARS}봉 · 지평선 ${HORIZONS.join('/')}일`)
  console.log('일봉이 실제로 있는 종목 조회 중...')
  const tickers = await tickersWithBars()
  console.log(`  → ${tickers.length}종목`)

  const all: Obs[] = []
  let scanned = 0
  for (const ticker of tickers) {
    const bars = await fetchAll<PriceHistoryRow>((from, to) =>
      db
        .from('stock_price_history')
        .select('ticker, market, date, open, high, low, close, volume')
        .eq('market', MARKET)
        .eq('ticker', ticker)
        .order('date', { ascending: true })
        .range(from, to),
    )
    scanned += 1
    if (scanned % 50 === 0) console.log(`  ...${scanned}/${tickers.length}종목 (관측 ${all.length}건)`)
    const maxH = Math.max(...HORIZONS)
    if (bars.length < MIN_BARS + maxH) continue

    for (let i = MIN_BARS - 1; i < bars.length - maxH; i += STEP) {
      // 그 시점까지의 일봉만 넘긴다 — 미래를 못 보게 하는 핵심 한 줄.
      // 뒤쪽 150봉으로 자르는 건 **판정을 바꾸지 않는다**: 5개 신호가 보는 최대 구간이
      // 120봉(120일선)이고, SMA·일목·RSI 모두 마지막 지점 값은 뒤쪽 구간만으로 정해진다.
      // 600봉을 통째로 넘기면 같은 답을 내면서 수십 배 느려진다(화면도 ~120봉만 넘긴다).
      const upto = bars.slice(Math.max(0, i + 1 - 150), i + 1)
      const a = assessSupportSignals(upto)
      const met: Partial<Record<SupportSignalId, boolean>> = {}
      for (const s of a.signals) if (s.met !== null) met[s.id] = s.met

      const close = bars[i].close
      if (close <= 0) continue
      const high = Math.max(...upto.slice(-120).map((b) => b.high))
      const fwd: Record<number, number> = {}
      for (const h of HORIZONS) fwd[h] = ((bars[i + h].close - close) / close) * 100

      all.push({
        ticker,
        date: bars[i].date,
        met,
        metCount: a.metCount,
        drawdownPct: high > 0 ? ((close - high) / high) * 100 : 0,
        fwd,
        adj: {},
      })
    }
  }

  // 날짜별 중앙값을 빼 시장 효과를 제거한다.
  for (const h of HORIZONS) {
    const byDate = new Map<string, number[]>()
    for (const o of all) {
      if (!byDate.has(o.date)) byDate.set(o.date, [])
      byDate.get(o.date)!.push(o.fwd[h])
    }
    const med = new Map<string, number>()
    for (const [d, xs] of byDate) med.set(d, median(xs))
    for (const o of all) o.adj[h] = o.fwd[h] - (med.get(o.date) ?? 0)
  }

  analyze(`전체 표본 (${MARKET})`, all)
  analyze(
    `물타기 상황만 — 120봉 고점 대비 ${DRAWDOWN_CUT}% 이상 하락 (${MARKET})`,
    all.filter((o) => o.drawdownPct <= -DRAWDOWN_CUT),
  )

  console.log(`\n${'='.repeat(78)}`)
  console.log('※ 생존 편향은 못 뺀다 — 유니버스가 *오늘* 기준이라, 과거에 폭락한 종목이')
  console.log('  목록에 있다는 건 그 사이 살아남았다는 뜻이다(backtestEtfStage.ts와 같은 한계).')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
