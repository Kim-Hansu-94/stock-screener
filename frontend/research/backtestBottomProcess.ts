/**
 * **"물타기 하고 나서 실제로 어떤 일이 벌어졌나"를 과정으로 재는 스크립트.**
 *
 * 왜 이게 필요한가 — 순서를 거꾸로 했다가 실패했다
 * ------------------------------------------------
 * 2026-11-11에 `backtestTurnSignals.ts`로 "하락이 멈추고 상승 전환"을 잡는 트리거
 * 후보 7개를 만들어 쟀고 **전부 기준선을 못 넘었다.** 돌아보면 순서가 틀렸다 —
 * 바닥이 **어떻게 생겼는지 재 보지도 않고** 지표부터 고른 것이다. 그래서 이번에는
 * 현상을 먼저 재고(1부), 그 모양에서 나온 조건만 시험한다(2부).
 *
 * 유일하게 단단했던 숫자는 기준선이었다: **15% 이상 빠진 종목을 추가 매수하면
 * 60거래일 안에 중간값 -15%까지 더 빠진다**(104,119건). 그런데 그 문장은 "그래서
 * 언제 바닥이 왔고, 그 뒤엔 어떻게 됐나"에 답하지 않는다. 사용자가 물은 것이 정확히
 * 그것이고, 분할매수 계획의 간격·대기 기간을 정하려면 그 답이 있어야 한다.
 *
 * 1부 — 바닥의 생김새
 * -------------------
 * 하락 국면(120봉 고점 대비 -DRAWDOWN_GATE% 이하)에 들어선 날을 '관측 시작'으로 잡고
 * 앞으로 FORWARD 거래일을 따라가며 잰다:
 *   - 저점까지 걸린 거래일 수 / 저점의 추가 하락폭
 *   - 저점 이후 60·120·250거래일 수익률
 *   - 시작 가격을 **회복했는가**, 했다면 며칠 걸렸는가
 * 집단은 전체 / 시총 상위(대형주) / 섹터별로 나눠 본다 — 사용자가 반도체·대형주를
 * 물었고, 실제로 성격이 다른지는 재 봐야 안다.
 *
 * 2부 — 저점 확인 대기 트리거 (격자)
 * ----------------------------------
 * 1부가 "바닥은 얼마 만에 오고 그 뒤 얼마나 오르나"를 알려 주면, 트리거는 하나의
 * 모양으로 좁혀진다: **"저점이 더 안 깨진 채로 얼마나 버텼고, 거기서 얼마나 올라왔나."**
 * 지표를 7개 늘어놓는 대신 **축 두 개짜리 격자**를 재는 이유다 —
 *   X = 저점 대비 반등폭(%), D = 저점이 안 깨진 거래일 수
 * 격자는 과최적화의 지름길이므로 **종목을 반으로 갈라(A/B) 양쪽을 다 찍는다.**
 * 한 칸이 좋은 것은 의미 없고, **면이 매끄럽고 A/B가 같은 방향**이어야 쓸 수 있다.
 * 그렇지 않으면 이번에도 "쓸 만한 게 없다"가 답이고, 그렇게 보고한다.
 *
 * 진입가는 **신호 다음 거래일 시가**다 — 당일 종가로 재면 반등 확인형 조건이
 * 갭상승분을 공짜로 먹는다(`docs/backtest-guide.md`의 '알려진 한계 2번').
 *
 * 읽기만 한다 — DB·사이트에 아무것도 쓰지 않는다.
 * 실행: `.github/workflows/bottom_process_backtest.yml`
 */
import { createClient } from '@supabase/supabase-js'
import type { PriceHistoryRow } from '../lib/types.ts'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_KEY
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY 가 필요합니다.')
  process.exit(1)
}
const db = createClient(url, key)

const MARKET = (process.env.MARKET ?? 'KR') as 'KR' | 'US'
/** 하락 국면 판정 — 120봉 고점 대비 이만큼 빠져 있어야 '물타기 상황'으로 본다. */
const DRAWDOWN_GATE = Number(process.env.DRAWDOWN_GATE ?? 15)
/** 관측을 앞으로 몇 거래일 따라갈지. 1년(250)이면 사용자가 물은 기간을 덮는다. */
const FORWARD = Number(process.env.FORWARD ?? 250)
const WARMUP = 130
/** 같은 하락 국면을 여러 번 세지 않으려고 둔다(한 번의 움직임을 수십 번 세면 안 된다). */
const EPISODE_COOLDOWN = Number(process.env.EPISODE_COOLDOWN ?? 20)
const TRIGGER_COOLDOWN = 20
/** 대형주 = 시총 상위 몇 종목으로 볼지. */
const LARGE_CAP_N = Number(process.env.LARGE_CAP_N ?? 50)
const PAGE = 1000

const REBOUND_PCTS = [5, 10, 15, 20]
const QUIET_DAYS = [5, 10, 20, 40]
const TRIGGER_HORIZON = 60

const maxOf = (xs: number[]) => xs.reduce((a, b) => (b > a ? b : a), -Infinity)
const median = (xs: number[]) => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const quantile = (xs: number[], q: number) => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)))]
}
const pct = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : '—')
const d0 = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : '—')
const line = (c = '─') => console.log(c.repeat(96))

async function fetchAll<T>(
  q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = []
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await q(start, start + PAGE - 1)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

interface Episode {
  ticker: string
  /** 저점까지 걸린 거래일 수. */
  daysToTrough: number
  /** 저점의 추가 하락폭(%). 관측 시작가 대비. */
  extraDropPct: number
  /** 저점 이후 수익률(%). */
  afterTrough: Record<number, number>
  /** 시작가를 회복했는가 / 며칠 걸렸는가(못 하면 null). */
  daysToRecover: number | null
}

interface Obs {
  ticker: string
  ret: number
}

async function main() {
  console.log(
    `시장 ${MARKET} · 하락국면 −${DRAWDOWN_GATE}% · 앞으로 ${FORWARD}거래일 추적 · 에피소드 쿨다운 ${EPISODE_COOLDOWN}일`,
  )

  // 유니버스 메타 — 섹터·시총으로 집단을 나눈다.
  const uni = await fetchAll<{ ticker: string; name: string; sector: string | null; market_cap: number | null }>(
    (f, t) =>
      db.from('stock_universe').select('ticker, name, sector, market_cap').eq('market', MARKET).range(f, t),
  )
  const sectorOf = new Map(uni.map((u) => [u.ticker, u.sector ?? '미분류']))
  const largeCaps = new Set(
    [...uni]
      .filter((u) => (u.market_cap ?? 0) > 0)
      .sort((a, b) => (b.market_cap ?? 0) - (a.market_cap ?? 0))
      .slice(0, LARGE_CAP_N)
      .map((u) => u.ticker),
  )
  console.log(`유니버스 ${uni.length}종목 · 대형주(시총 상위) ${largeCaps.size}종목`)

  // 일봉이 있는 종목 — 최신 거래일 하루치로 목록을 만든다.
  const latest = await db
    .from('stock_price_history')
    .select('date')
    .eq('market', MARKET)
    .order('date', { ascending: false })
    .limit(1)
  const day = latest.data?.[0]?.date
  if (!day) throw new Error('일봉이 없다')
  const tickers = [
    ...new Set(
      (
        await fetchAll<{ ticker: string }>((f, t) =>
          db.from('stock_price_history').select('ticker').eq('market', MARKET).eq('date', day).range(f, t),
        )
      ).map((r) => r.ticker),
    ),
  ].sort()
  console.log(`일봉 보유 ${tickers.length}종목 (기준일 ${day})\n`)

  const episodes: Episode[] = []
  // 2부용 — 격자 셀마다 관측치를 모은다. 키는 `${x}|${d}`.
  const cells = new Map<string, Obs[]>()
  const baseline: Obs[] = []
  let scanned = 0

  for (const ticker of tickers) {
    const bars = await fetchAll<PriceHistoryRow>((f, t) =>
      db
        .from('stock_price_history')
        .select('ticker, market, date, open, high, low, close, volume')
        .eq('market', MARKET)
        .eq('ticker', ticker)
        .order('date', { ascending: true })
        .range(f, t),
    )
    scanned += 1
    if (scanned % 100 === 0) {
      console.log(`  ...${scanned}/${tickers.length}종목 (에피소드 ${episodes.length}건)`)
    }
    if (bars.length < WARMUP + 40) continue

    const close = bars.map((b) => b.close)
    const high = bars.map((b) => b.high)
    const open = bars.map((b) => b.open)

    let lastEpisode = -Infinity
    const lastFire = new Map<string, number>()

    for (let i = WARMUP; i < bars.length - 1; i += 1) {
      const hi = maxOf(high.slice(Math.max(0, i - 119), i + 1))
      if (!(hi > 0)) continue
      const dd = ((close[i] - hi) / hi) * 100
      if (dd > -DRAWDOWN_GATE) continue

      // ── 1부: 에피소드 (앞으로 FORWARD일이 다 있어야 집계) ────────────
      if (i - lastEpisode >= EPISODE_COOLDOWN && i + FORWARD < bars.length) {
        lastEpisode = i
        const startPrice = close[i]
        const fwd = close.slice(i + 1, i + 1 + FORWARD)
        let troughRel = 0
        for (let k = 1; k < fwd.length; k += 1) if (fwd[k] < fwd[troughRel]) troughRel = k
        const trough = fwd[troughRel]
        const afterTrough: Record<number, number> = {}
        for (const h of [60, 120, 250]) {
          const at = troughRel + h
          afterTrough[h] = at < fwd.length ? ((fwd[at] - trough) / trough) * 100 : NaN
        }
        let daysToRecover: number | null = null
        for (let k = 0; k < fwd.length; k += 1) {
          if (fwd[k] >= startPrice) {
            daysToRecover = k + 1
            break
          }
        }
        episodes.push({
          ticker,
          daysToTrough: troughRel + 1,
          extraDropPct: ((trough - startPrice) / startPrice) * 100,
          afterTrough,
          daysToRecover,
        })
      }

      // ── 2부: 격자 트리거 + 기준선 ────────────────────────────────────
      if (i + 1 + TRIGGER_HORIZON >= bars.length) continue
      const entry = open[i + 1]
      if (!(entry > 0)) continue
      const ret = ((close[i + 1 + TRIGGER_HORIZON] - entry) / entry) * 100
      baseline.push({ ticker, ret })

      // 지금까지의 최저점(최근 120봉)과 그 뒤로 며칠 지났는가.
      const win = close.slice(Math.max(0, i - 119), i + 1)
      let lowRel = 0
      for (let k = 1; k < win.length; k += 1) if (win[k] < win[lowRel]) lowRel = k
      const low = win[lowRel]
      const sinceLow = win.length - 1 - lowRel
      const upFromLow = ((close[i] - low) / low) * 100

      for (const x of REBOUND_PCTS) {
        for (const dq of QUIET_DAYS) {
          if (upFromLow < x || sinceLow < dq) continue
          const k = `${x}|${dq}`
          const last = lastFire.get(k)
          if (last !== undefined && i - last < TRIGGER_COOLDOWN) continue
          lastFire.set(k, i)
          const bucket = cells.get(k)
          if (bucket) bucket.push({ ticker, ret })
          else cells.set(k, [{ ticker, ret }])
        }
      }
    }
  }

  // ── 1부 출력 ────────────────────────────────────────────────────────
  const groups: [string, Episode[]][] = [
    ['전체', episodes],
    [`대형주 상위${LARGE_CAP_N}`, episodes.filter((e) => largeCaps.has(e.ticker))],
  ]
  // 섹터는 건수 많은 순 상위 6개만 — 적은 섹터는 숫자가 흔들린다.
  const bySector = new Map<string, Episode[]>()
  for (const e of episodes) {
    const s = sectorOf.get(e.ticker) ?? '미분류'
    const b = bySector.get(s)
    if (b) b.push(e)
    else bySector.set(s, [e])
  }
  for (const [s, es] of [...bySector.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6)) {
    groups.push([`섹터: ${s}`, es])
  }

  line('=')
  console.log('1부 — 물타기 상황에 들어선 뒤 실제로 벌어진 일')
  console.log(`  관측 시작 = 120봉 고점 대비 −${DRAWDOWN_GATE}% 이하인 날 (종목당 ${EPISODE_COOLDOWN}일 쿨다운)`)
  line('=')
  for (const [label, es] of groups) {
    if (es.length < 30) continue
    const recovered = es.filter((e) => e.daysToRecover !== null)
    console.log(`\n▶ ${label} — ${es.length}건 (${new Set(es.map((e) => e.ticker)).size}종목)`)
    console.log(
      `  저점까지 ${d0(median(es.map((e) => e.daysToTrough)))}거래일 (25%분위 ${d0(
        quantile(es.map((e) => e.daysToTrough), 0.25),
      )} · 75%분위 ${d0(quantile(es.map((e) => e.daysToTrough), 0.75))})`,
    )
    console.log(
      `  추가 하락폭 중간값 ${pct(median(es.map((e) => e.extraDropPct)))}` +
        ` (25%분위 ${pct(quantile(es.map((e) => e.extraDropPct), 0.25))} · 75%분위 ${pct(
          quantile(es.map((e) => e.extraDropPct), 0.75),
        )})`,
    )
    for (const h of [60, 120, 250]) {
      const v = es.map((e) => e.afterTrough[h]).filter((x) => Number.isFinite(x))
      if (v.length >= 30) console.log(`  저점 이후 ${String(h).padStart(3)}일: 중간값 ${pct(median(v))} (${v.length}건)`)
    }
    console.log(
      `  시작가 회복: ${((recovered.length / es.length) * 100).toFixed(1)}%가 ${FORWARD}일 안에 회복` +
        ` · 걸린 일수 중간값 ${d0(median(recovered.map((e) => e.daysToRecover as number)))}거래일`,
    )
  }

  // ── 2부 출력 ────────────────────────────────────────────────────────
  const half = new Map([...new Set(baseline.map((o) => o.ticker))].sort().map((t, i) => [t, i % 2]))
  const sub = (os: Obs[], g: number) => os.filter((o) => half.get(o.ticker) === g)
  const baseAll = median(baseline.map((o) => o.ret))
  const baseA = median(sub(baseline, 0).map((o) => o.ret))
  const baseB = median(sub(baseline, 1).map((o) => o.ret))

  line('=')
  console.log(`2부 — 저점 확인 대기 트리거 (${TRIGGER_HORIZON}거래일 수익률 중간값, 다음날 시가 진입)`)
  console.log(
    `  기준선(하락 국면 아무 날) ${pct(baseAll)} · ${baseline.length}건` +
      `  [A조 ${pct(baseA)} · B조 ${pct(baseB)}]`,
  )
  console.log('  읽는 법: 한 칸이 좋은 건 의미 없다. **면이 매끄럽고 A/B가 같은 방향**이어야 쓸 수 있다.')
  line('=')
  console.log('\n  저점대비반등 \\ 저점이 안 깨진 일수')
  console.log(
    '  ' + '       '.padEnd(9) + QUIET_DAYS.map((d) => `${d}일`.padStart(22)).join(''),
  )
  for (const x of REBOUND_PCTS) {
    const cellsRow = QUIET_DAYS.map((dq) => {
      const os = cells.get(`${x}|${dq}`) ?? []
      if (os.length < 200) return '표본부족'.padStart(22)
      const m = median(os.map((o) => o.ret)) - baseAll
      const a = median(sub(os, 0).map((o) => o.ret)) - baseA
      const b = median(sub(os, 1).map((o) => o.ret)) - baseB
      return `${pct(m)}(A${pct(a)} B${pct(b)})`.padStart(22)
    })
    console.log(`  +${String(x).padStart(2)}% 이상 `.padEnd(11) + cellsRow.join(''))
  }
  console.log('\n  (값은 **기준선 대비 초과 수익률**이다. 0 근처면 우위가 없다는 뜻.)')
  const counts = REBOUND_PCTS.map((x) =>
    QUIET_DAYS.map((dq) => `${x}/${dq}:${(cells.get(`${x}|${dq}`) ?? []).length}`).join('  '),
  )
  console.log('\n  셀별 표본 수')
  for (const c of counts) console.log(`    ${c}`)

  line('=')
  console.log('※ 생존 편향은 못 뺀다 — 유니버스가 오늘 기준 목록이다.')
  console.log('※ 에피소드는 종목당 쿨다운을 둬도 서로 기간이 겹친다. 믿을 숫자는 건수가 아니라 종목 수다.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
