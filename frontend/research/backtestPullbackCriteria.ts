/**
 * **눌림목 스크리너가 왜 마이너스인지 — 조건별로 쪼개서 찾는다.**
 *
 * 2026-11-11에 실전 성적을 뽑아 보니 KR 기댓값 −0.163R, US −0.076R로 둘 다 마이너스였고,
 * **조건을 더 맞춘 종목이 더 나빴다**(KR 미달 1개 −0.661R < 2개 −0.462R < 3개 −0.157R).
 * 그건 임계값이 어긋난 게 아니라 **조건 중 하나 이상이 거꾸로 박혀 있다**는 신호다.
 * `pattern_discovery.py`를 2026-09-14에 고친 방법이 정확히 이것이었다(거래량 점수가
 * 성과와 반대 방향인 것을 찾아냈다).
 *
 * 그래서 이 스크립트는 **임계값을 돌려 보지 않는다.** 같은 데이터에 수십 개 파라미터를
 * 맞춰 돌리면 승률 50%는 반드시 만들 수 있고 그건 발견이 아니라 과최적화다
 * (`docs/backtest-guide.md`가 적어 둔 그대로). 대신 묻는 것은 하나다:
 *
 *   **각 조건은 성과와 같은 방향인가, 반대 방향인가?**
 *
 * 조건을 **못 맞춘 쪽이 더 좋다면** 그 조건은 거꾸로다 — 그것만 고친다.
 *
 * 설계
 * ----
 * - 조건 판정은 파이썬이 **실제 `evaluate_pullback()`**으로 미리 해서 NDJSON에 담았다
 *   (`pipeline/research/dump_pullback_signals.py`). 기존 `backtest_pullback.py`는 8개 조건 중
 *   4개만 구현해 지금 화면을 설명하지 못한다 — 그 한계를 피하려고 실제 함수를 쓴다.
 * - 손절·목표·R 집계는 화면이 쓰는 `computeStopTarget`·`resolveTrade`·`summarize`를
 *   **그대로** 쓴다. 어느 쪽도 포팅하지 않는다.
 * - **진입가를 두 가지로 잰다**: (a) 추천일 종가 — 화면 성적표가 쓰는 값, (b) 다음 거래일
 *   시가 — 실제로 살 수 있는 값. 둘의 차이가 `docs/backtest-guide.md` '알려진 한계 2번'이
 *   말하는 부풀림의 크기다.
 * - **검증용 구간을 떼어 둔다**: 날짜 기준 앞 절반(탐색) / 뒤 절반(검증). 앞에서 찾은
 *   방향이 뒤에서도 같아야 믿을 수 있다. 전부에 맞추면 아무것도 배우지 못한다.
 *
 * 실행: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... SIGNALS=/tmp/kr.ndjson MARKET=KR \
 *   node --import ./research/resolveTsImports.mjs research/backtestPullbackCriteria.ts
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { createClient } from '@supabase/supabase-js'
import { computeStopTarget, type PriceBar } from '../lib/risk.ts'
import { resolveTrade, summarize, type ResolvedTrade, type Scorecard } from '../lib/scorecard.ts'
import type { Market } from '../lib/types.ts'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_KEY
const SIGNALS = process.env.SIGNALS
if (!url || !key || !SIGNALS) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY / SIGNALS 가 필요합니다.')
  process.exit(1)
}
const db = createClient(url, key)
const MARKET = (process.env.MARKET ?? 'KR') as Market
/** 화면이 실제로 보여주는 범위 — 미달이 이 개수 이하인 후보만 '추천'으로 본다. */
const MAX_MISS = Number(process.env.MAX_MISS ?? 3)
const PAGE = 1000

/** 파이썬이 떨어뜨린 한 줄. `f`는 미달 조건 이름 목록(빈 배열 = 전 조건 통과). */
interface SignalRow {
  t: string
  d: string
  c: number
  f: string[]
}

const num = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`
const pct = (v: number) => `${(v * 100).toFixed(1)}%`
const line = (c = '─') => console.log(c.repeat(96))

async function fetchAll<T>(
  q: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = []
  for (let f = 0; ; f += PAGE) {
    const { data, error } = await q(f, f + PAGE - 1)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) break
  }
  return out
}

async function readSignals(path: string): Promise<SignalRow[]> {
  const rows: SignalRow[] = []
  const rl = createInterface({ input: createReadStream(path, 'utf-8'), crlfDelay: Infinity })
  for await (const l of rl) {
    if (!l.trim()) continue
    rows.push(JSON.parse(l) as SignalRow)
  }
  return rows
}

type Bar = PriceBar & { open: number }

/** 한 트레이드 = 한 (종목, 날짜). 진입가 기준 두 가지를 같이 들고 다닌다. */
interface Pair {
  closeEntry: ResolvedTrade | null
  openEntry: ResolvedTrade | null
  failed: string[]
  date: string
  ticker: string
}

function card(label: string, trades: ResolvedTrade[]): string {
  const c: Scorecard = summarize(trades)
  if (c.resolved === 0) return `  ${label.padEnd(26)} 표본 없음`
  return (
    `  ${label.padEnd(26)}${String(c.resolved).padStart(6)}건  ` +
    `기댓값 ${num(c.expectancyR).padStart(7)}R  ` +
    `목표도달 ${pct(c.hitRate).padStart(6)} (본전선 ${pct(c.breakevenHitRate)})`
  )
}

/**
 * 거꾸로 박힌 것으로 **구간 분리 검증까지 일관되게** 나온 조건들.
 *
 * 2026-11-11 측정(17,604건, 탐색/검증 둘 다 같은 부호):
 *   눌림 구간 밖   탐색 -0.032R / 검증 -0.078R   ← 미달 쪽이 더 좋다 = 거꾸로
 *   거래량 미감소   탐색 -0.017R / 검증 -0.050R   ← 같은 모양
 *
 * 후자는 `pattern_discovery.py`가 2026-09-14에 고친 것과 **같은 종류의 오류**다
 * (거래량 점수가 성과와 반대 방향이었다). 그래서 이 둘을 미달로 세지 않는 랭킹과
 * 지금 랭킹을 나란히 재 본다 — 상수를 돌리는 게 아니라 **조건 하나를 빼는 것**이고,
 * 효과는 `passed` 표시와 **하루 5종목 줄 세우기**에 나타난다.
 */
const INVERTED = ['눌림 구간 밖', '거래량 미감소']

/**
 * 하루에 상위 N건만 남긴다 — 파이프라인의 `TOP_CANDIDATES`(5)와 같은 방식.
 *
 * **이게 없으면 모집단이 다르다.** 화면에 뜨는 건 그날 평가한 수백 종목 전부가 아니라
 * "전 조건 통과분 + 미달이 가장 적은 근접 후보"로 채운 5개뿐이다(`pipeline.py`의
 * `_screen_candidates`). 17,604건을 통째로 재면 실제로 추천된 적 없는 것까지 세게 된다.
 *
 * **다른 점 하나를 밝혀 둔다**: 파이프라인은 미달 개수가 같을 때 선행 상승(impulse_gain)
 * 큰 순으로 가른다. 덤프에 그 값이 없어 여기서는 종목코드 순으로 가르므로, 동순위
 * 안에서의 선택은 실제와 다를 수 있다. 미달 개수별 줄 세우기 자체는 같다.
 */
function topPerDay(pairs: Pair[], missOf: (p: Pair) => number, n: number): Pair[] {
  const byDate = new Map<string, Pair[]>()
  for (const p of pairs) {
    const bucket = byDate.get(p.date)
    if (bucket) bucket.push(p)
    else byDate.set(p.date, [p])
  }
  const out: Pair[] = []
  for (const group of byDate.values()) {
    group.sort((a, b) => missOf(a) - missOf(b) || a.ticker.localeCompare(b.ticker))
    out.push(...group.slice(0, n))
  }
  return out
}

/**
 * 종목당 가장 이른 신호 하나만 — `getScorecardTrades`와 같은 중복 제거.
 * 같은 종목이 눌림목 구간 내내 반복 추천되므로, 이걸 안 하면 한 번의 움직임을
 * 수십 번 세게 된다(`backtestTurnSignals.ts`의 쿨다운과 같은 이유).
 */
function firstPerTicker(pairs: Pair[]): Pair[] {
  const first = new Map<string, Pair>()
  for (const p of [...pairs].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!first.has(p.ticker)) first.set(p.ticker, p)
  }
  return [...first.values()]
}

function expectancy(trades: ResolvedTrade[]): number {
  const c = summarize(trades)
  return c.resolved === 0 ? NaN : c.expectancyR
}

async function main() {
  console.log(`시장 ${MARKET} · 신호 파일 ${SIGNALS} · 추천 범위 = 미달 ${MAX_MISS}개 이하`)
  const signals = await readSignals(SIGNALS!)
  console.log(`신호 ${signals.length}행 · 전 조건 통과 ${signals.filter((s) => s.f.length === 0).length}건`)

  // 화면이 보여주는 범위로 좁힌다 — 전 종목 전 날짜를 다 세면 '추천'이 아닌 것까지 들어간다.
  const picks = signals.filter((s) => s.f.length <= MAX_MISS)
  const tickers = [...new Set(picks.map((s) => s.t))]
  console.log(`  → 추천 후보 ${picks.length}건 · ${tickers.length}종목`)

  // 종목별 일봉을 한 번만 받아 둔다.
  const bars = new Map<string, Bar[]>()
  let n = 0
  for (const t of tickers) {
    const rows = await fetchAll<Bar & { ticker: string }>((a, b) =>
      db
        .from('stock_price_history')
        .select('ticker, date, open, high, low, close')
        .eq('market', MARKET)
        .eq('ticker', t)
        .order('date', { ascending: true })
        .range(a, b),
    )
    bars.set(t, rows)
    n += 1
    if (n % 100 === 0) console.log(`  일봉 ${n}/${tickers.length}종목`)
  }

  const pairs: Pair[] = []
  for (const s of picks) {
    const all = bars.get(s.t) ?? []
    if (all.length === 0) continue
    const idx = all.findIndex((b) => b.date === s.d)
    if (idx < 0) continue
    const pre = all.slice(0, idx + 1)
    const future = all.slice(idx + 1)
    if (future.length === 0) continue

    const mk = (entry: number, fut: Bar[]): ResolvedTrade | null => {
      if (!(entry > 0)) return null
      // 손절·목표는 추천일까지의 봉으로 잡는다(화면과 같다).
      const { stop, target } = computeStopTarget(pre, entry)
      if (stop === null || target === null) return null
      return resolveTrade({
        date: s.d,
        market: MARKET,
        ticker: s.t,
        name: s.t,
        sector: '',
        entry,
        stop,
        target,
        futureBars: fut,
        regime: null,
        failedCriteria: s.f,
      })
    }

    pairs.push({
      date: s.d,
      ticker: s.t,
      failed: s.f,
      // (a) 화면 성적표와 같은 기준 — 추천일 종가로 진입했다고 가정
      closeEntry: mk(s.c, future),
      // (b) 실제로 살 수 있는 기준 — 다음 거래일 시가
      openEntry: future.length > 1 ? mk(future[0].open, future.slice(1)) : null,
    })
  }

  const closeTrades = pairs.map((p) => p.closeEntry).filter((t): t is ResolvedTrade => t !== null)
  const openTrades = pairs.map((p) => p.openEntry).filter((t): t is ResolvedTrade => t !== null)

  line('=')
  console.log('전체 — 진입가 기준 두 가지')
  line('=')
  console.log(card('(a) 추천일 종가 진입', closeTrades))
  console.log(card('(b) 다음날 시가 진입', openTrades))
  console.log('  ※ (b)가 실제로 살 수 있는 가격이다. (a)-(b) 차이가 종가 진입 가정의 부풀림이다.')

  // ── 핵심: 조건별 방향 ────────────────────────────────────────────────
  const criteria = [...new Set(picks.flatMap((s) => s.f))].sort()
  for (const [entryLabel, sel] of [
    ['(b) 다음날 시가 진입', (p: Pair) => p.openEntry],
    ['(a) 추천일 종가 진입', (p: Pair) => p.closeEntry],
  ] as [string, (p: Pair) => ResolvedTrade | null][]) {
    line('=')
    console.log(`조건별 방향 — ${entryLabel}`)
    console.log('  "미달 쪽이 더 좋다"면 그 조건은 거꾸로 박힌 것이다.')
    line('=')
    const rows: { name: string; metN: number; failN: number; met: number; fail: number; diff: number }[] = []
    for (const crit of criteria) {
      const met: ResolvedTrade[] = []
      const fail: ResolvedTrade[] = []
      for (const p of pairs) {
        const t = sel(p)
        if (!t) continue
        if (p.failed.includes(crit)) fail.push(t)
        else met.push(t)
      }
      const em = expectancy(met)
      const ef = expectancy(fail)
      rows.push({
        name: crit,
        metN: summarize(met).resolved,
        failN: summarize(fail).resolved,
        met: em,
        fail: ef,
        diff: em - ef,
      })
    }
    rows.sort((a, b) => (Number.isFinite(a.diff) ? a.diff : 99) - (Number.isFinite(b.diff) ? b.diff : 99))
    for (const r of rows) {
      const verdict = !Number.isFinite(r.diff)
        ? '표본 부족'
        : r.diff < -0.1
          ? '⚠ 거꾸로 (미달 쪽이 좋다)'
          : r.diff > 0.1
            ? '정방향'
            : '차이 미미'
      console.log(
        `  ${r.name.padEnd(14)} 충족 ${String(r.metN).padStart(5)}건 ${num(r.met).padStart(7)}R` +
          ` · 미달 ${String(r.failN).padStart(5)}건 ${num(r.fail).padStart(7)}R` +
          ` · 차이 ${num(r.diff).padStart(7)}R  ${verdict}`,
      )
    }
  }

  // ── 모집단을 화면과 맞춘다: 하루 5종목 + 종목당 1건 ──────────────────
  // 여기까지의 숫자는 **추천된 적 없는 것까지 센 것**이다. 화면에 실제로 뜨는 건
  // 그날 미달이 가장 적은 상위 5개뿐이고(`TOP_CANDIDATES`), 성적표는 거기서 다시
  // 종목당 첫 추천 1건만 센다. 그래서 실전 성적(KR 55건)과 모집단이 달랐다.
  const dates0 = [...new Set(pairs.map((p) => p.date))].sort()
  const split0 = dates0[Math.floor(dates0.length / 2)]
  const missAll = (p: Pair) => p.failed.length
  const missTrimmed = (p: Pair) => p.failed.filter((f) => !INVERTED.includes(f)).length

  line('=')
  console.log('모집단을 화면과 맞춘 성적 — 하루 상위 5종목 · 종목당 첫 1건')
  console.log('  (b) 다음날 시가 진입 기준. 실전 성적표와 같은 모집단이어야 숫자를 맞댈 수 있다.')
  line('=')
  for (const [label, missOf] of [
    ['지금 랭킹 (8개 조건)', missAll],
    [`거꾸로 2개 뺀 랭킹 (${INVERTED.join('·')})`, missTrimmed],
  ] as [string, (p: Pair) => number][]) {
    const top = topPerDay(pairs, missOf, 5)
    const dedup = firstPerTicker(top)
    const pick = (ps: Pair[]) => ps.map((p) => p.openEntry).filter((t): t is ResolvedTrade => t !== null)
    console.log(`\n  ${label}`)
    console.log(card('    하루 5종목 전부', pick(top)))
    console.log(card('    + 종목당 첫 1건', pick(dedup)))
    // 구간 분리 — 조건을 뺀 효과가 뒤 구간에서도 남아야 믿을 수 있다.
    console.log(
      card('    └ 탐색 구간', pick(dedup.filter((p) => p.date < split0))) +
        '\n' +
        card('    └ 검증 구간', pick(dedup.filter((p) => p.date >= split0))),
    )
  }

  // 랭킹이 제대로 줄 세우는지 — 실전 성적에서 "미달 적은 쪽이 더 나빴다"가 나온 그 축.
  line('=')
  console.log('랭킹 축 점검 — 미달 개수가 적을수록 성적이 좋아야 한다')
  console.log('  실전 55건에서는 거꾸로였다(미달 1개 -0.661R < 2개 -0.462R < 3개 -0.157R).')
  console.log('  표본을 키워도 거꾸로면 랭킹 자체가 잘못 줄 세우고 있다는 뜻이다.')
  line('=')
  for (const [label, missOf] of [
    ['8개 조건 기준', missAll],
    ['거꾸로 2개 뺀 기준', missTrimmed],
  ] as [string, (p: Pair) => number][]) {
    console.log(`\n  ${label}`)
    for (let k = 0; k <= MAX_MISS; k += 1) {
      const ts = pairs
        .filter((p) => missOf(p) === k)
        .map((p) => p.openEntry)
        .filter((t): t is ResolvedTrade => t !== null)
      console.log(card(`    미달 ${k}개`, ts))
    }
  }

  // ── 검증용 구간 분리 ────────────────────────────────────────────────
  const dates = dates0
  const split = split0
  line('=')
  console.log(`구간 분리 검증 — 탐색 ${dates[0]}~${split} / 검증 ${split}~${dates[dates.length - 1]}`)
  console.log('  앞 구간에서 거꾸로였던 조건이 뒤 구간에서도 거꾸로여야 믿을 수 있다.')
  line('=')
  for (const crit of criteria) {
    const parts: string[] = []
    for (const [label, keep] of [
      ['탐색', (p: Pair) => p.date < split],
      ['검증', (p: Pair) => p.date >= split],
    ] as [string, (p: Pair) => boolean][]) {
      const met: ResolvedTrade[] = []
      const fail: ResolvedTrade[] = []
      for (const p of pairs) {
        if (!keep(p)) continue
        const t = p.openEntry
        if (!t) continue
        if (p.failed.includes(crit)) fail.push(t)
        else met.push(t)
      }
      const d = expectancy(met) - expectancy(fail)
      parts.push(`${label} ${Number.isFinite(d) ? num(d) + 'R' : '—'}`)
    }
    console.log(`  ${crit.padEnd(14)} ${parts.join('  ·  ')}`)
  }

  line('=')
  console.log('※ 이 스크립트는 임계값을 돌려 보지 않는다 — 같은 데이터에 맞춰 승률을 만들면')
  console.log('  발견이 아니라 과최적화다. 묻는 것은 "각 조건이 성과와 같은 방향인가" 하나다.')
  console.log('※ 조건 판정은 실제 evaluate_pullback(), 손절·목표·R은 화면이 쓰는 함수를 그대로 썼다.')
  console.log('※ 생존 편향은 못 뺀다 — 유니버스가 오늘 기준이다.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
