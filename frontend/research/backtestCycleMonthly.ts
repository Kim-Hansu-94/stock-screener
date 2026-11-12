/**
 * **월봉 10년으로 "사이클 한 주기"를 재는 스크립트.** 그리고 왜 일봉으로는 못 쟀는지
 * 같은 실행에서 증거로 찍는다.
 *
 * 왜 일봉으로는 안 되는가 — 추측하지 말고 세어 보자
 * --------------------------------------------------
 * `backtestBottomProcess.ts`(일봉)에서 국내 반도체가 **1종목(한미반도체)**만 잡혔다.
 * 그때 "SK하이닉스 폭락이 너무 최근이라서"라고 **추측해서 말했는데 근거가 없었다.**
 * 진짜 이유는 따로 있을 수 있다:
 *
 *   `stock_price_history`는 600일만 보관한다 → 종목당 거래일 약 400봉.
 *   거기서 워밍업 130봉을 빼고, 앞으로 250거래일이 남아 있어야 에피소드가 성립한다.
 *   → **에피소드가 시작될 수 있는 구간이 400 − 130 − 250 ≈ 20봉뿐이다.**
 *
 * 그렇다면 "반도체가 안 잡혔다"는 종목의 성질이 아니라 **창이 좁아서**일 수 있다.
 * 1부가 종목별로 (봉 수 / 시작 가능 구간 / 그 구간의 실제 하락폭)을 찍어 가린다.
 *
 * 2부 — 월봉으로 다시 잰다
 * -------------------------
 * `stock_long_monthly`는 **10년치**다. 월 해상도면 2018~19 메모리 불황과 2022
 * 하락장이 창에 들어오므로, 일봉으로는 구조적으로 불가능했던 **사이클 하강기**를
 * 처음으로 볼 수 있다. 측정 내용은 일봉판과 같되 단위가 달이다:
 *   12개월 고점 대비 -15% 이하인 달을 관측 시작 → 앞으로 24개월 추적
 *   저점까지 몇 달 / 추가 하락폭 / 그냥 들고 6·12·24개월 / 저점 이후 회복
 *
 * **에피소드를 시작 연도별로도 쪼갠다** — 사이클을 보자는 것이므로 "어느 시기
 * 에피소드인지"가 숫자만큼 중요하다. 전부 한 해에 몰려 있으면 그건 사이클이 아니라
 * 그 해를 잰 것이다.
 *
 * 한계를 미리 적어 둔다
 * ---------------------
 * - 월 해상도라 달 안의 저점은 못 본다. "저점까지 3개월"은 ±1개월 눈금이다.
 * - 10년 시드 구간은 `close_high`가 null이라(스키마 주석) **`close`로만 판정한다.**
 * - 생존 편향은 여전히 못 뺀다 — 유니버스가 오늘 기준 목록이다. 10년 전에 상장폐지된
 *   종목은 아예 없으므로 **긴 창일수록 이 편향이 커진다.** 일봉판보다 더 조심할 것.
 *
 * 읽기만 한다. 실행: `.github/workflows/cycle_monthly_backtest.yml`
 */
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_KEY
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY 가 필요합니다.')
  process.exit(1)
}
const db = createClient(url, key)

const MARKET = (process.env.MARKET ?? 'KR') as 'KR' | 'US'
const DRAWDOWN_GATE = Number(process.env.DRAWDOWN_GATE ?? 15)
/** 고점을 재는 창(개월). 일봉판의 120봉(약 6개월)보다 넉넉히 1년으로 둔다. */
const HIGH_WINDOW = 12
/** 앞으로 추적할 개월 수. 반도체 사이클 한 국면을 덮도록 2년. */
const FORWARD_M = Number(process.env.FORWARD_M ?? 24)
const WARMUP_M = HIGH_WINDOW
const COOLDOWN_M = 6
const PAGE = 1000

/** 일봉판과 **같은 목록**을 쓴다 — 두 측정을 맞대려면 집단 정의가 같아야 한다. */
const SEMI = new Set([
  'NVDA', 'AMD', 'INTC', 'MU', 'AVGO', 'QCOM', 'TXN', 'ADI', 'MCHP', 'NXPI',
  'ON', 'SWKS', 'QRVO', 'MPWR', 'MRVL', 'WOLF', 'LSCC', 'SLAB', 'SIMO', 'AMKR',
  'TSM', 'STM', 'UMC', 'GFS', 'ALGM', 'SITM', 'RMBS', 'CRUS', 'SYNA', 'POWI',
  'DIOD', 'MTSI', 'AOSL', 'VSH', 'NVTS', 'INDI',
  'AMAT', 'LRCX', 'KLAC', 'ASML', 'TER', 'ENTG', 'MKSI', 'ONTO', 'ACMR', 'UCTT',
  'COHU', 'FORM', 'AEIS', 'CAMT', 'PLAB', 'AXT', 'NVMI', 'KLIC', 'ICHR',
  '000660', '005930', '042700', '000990',
])
/** 1부 진단에서 "왜 안 잡혔나"를 이름까지 찍을 종목. */
const DIAG = ['005930', '000660', '042700', '000990', 'NVDA', 'MU', 'AMD', 'AMAT']

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
  q: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = []
  for (let s = 0; ; s += PAGE) {
    const { data, error } = await q(s, s + PAGE - 1)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

interface Ep {
  ticker: string
  startMonth: string
  monthsToTrough: number
  extraDropPct: number
  hold: Record<number, number>
  monthsToRecover: number | null
  stillFalling: boolean
}

async function main() {
  console.log(
    `시장 ${MARKET} · 월봉 · ${HIGH_WINDOW}개월 고점 대비 −${DRAWDOWN_GATE}% · 앞으로 ${FORWARD_M}개월 추적`,
  )

  // ── 1부: 일봉으로는 왜 못 쟀나 — 세어서 보여 준다 ────────────────────
  line('=')
  console.log('1부 — "국내 반도체가 1종목뿐"이었던 이유를 숫자로 가린다')
  console.log('  일봉판 조건: 워밍업 130봉 + 앞으로 250거래일이 남아 있어야 에피소드가 성립')
  line('=')
  for (const t of DIAG) {
    const uni = await db
      .from('stock_universe')
      .select('ticker, name, sector')
      .eq('market', MARKET)
      .eq('ticker', t)
      .limit(1)
    const u = uni.data?.[0]
    if (!u) {
      console.log(`  ${t}: **유니버스에 없음** → 일봉도 안 쌓인다`)
      continue
    }
    const bars = await fetchAll<{ date: string; close: number; high: number }>((f, to) =>
      db
        .from('stock_price_history')
        .select('date, close, high')
        .eq('market', MARKET)
        .eq('ticker', t)
        .order('date', { ascending: true })
        .range(f, to),
    )
    const n = bars.length
    const lo = 130
    const hi = n - 250 - 1
    let eligible = 0
    let worst = 0
    for (let i = lo; i <= hi; i += 1) {
      const h = Math.max(...bars.slice(Math.max(0, i - 119), i + 1).map((b) => b.high))
      const dd = ((bars[i].close - h) / h) * 100
      if (dd < worst) worst = dd
      if (dd <= -DRAWDOWN_GATE) eligible += 1
    }
    console.log(
      `  ${t} ${u.name ?? ''} · 일봉 ${n}봉` +
        ` · 에피소드 시작 가능 구간 ${Math.max(0, hi - lo + 1)}봉(${bars[lo]?.date ?? '—'}~${bars[hi]?.date ?? '—'})` +
        ` · 그중 −${DRAWDOWN_GATE}% 이하인 날 ${eligible}일 · 그 구간 최대 낙폭 ${pct(worst)}`,
    )
  }

  // ── 2부: 월봉으로 다시 ───────────────────────────────────────────────
  const rows = await fetchAll<{ ticker: string; month_start: string; close: number }>((f, t) =>
    db
      .from('stock_long_monthly')
      .select('ticker, month_start, close')
      .eq('market', MARKET)
      .order('ticker')
      .order('month_start')
      .range(f, t),
  )
  const byTicker = new Map<string, { m: string; c: number }[]>()
  for (const r of rows) {
    if (!(r.close > 0)) continue
    const b = byTicker.get(r.ticker)
    if (b) b.push({ m: r.month_start, c: r.close })
    else byTicker.set(r.ticker, [{ m: r.month_start, c: r.close }])
  }
  const months = rows.map((r) => r.month_start).sort()
  console.log(
    `\n월봉 ${rows.length}행 · ${byTicker.size}종목 · ${months[0] ?? '—'} ~ ${months[months.length - 1] ?? '—'}`,
  )

  const uni = await fetchAll<{ ticker: string; name: string; sector: string | null }>((f, t) =>
    db.from('stock_universe').select('ticker, name, sector').eq('market', MARKET).range(f, t),
  )
  const nameOf = new Map(uni.map((u) => [u.ticker, u.name ?? u.ticker]))

  const eps: Ep[] = []
  for (const [ticker, bars] of byTicker) {
    bars.sort((a, b) => a.m.localeCompare(b.m))
    let last = -Infinity
    for (let i = WARMUP_M; i < bars.length - FORWARD_M; i += 1) {
      const hi = Math.max(...bars.slice(i - HIGH_WINDOW, i + 1).map((b) => b.c))
      if (!(hi > 0)) continue
      if (((bars[i].c - hi) / hi) * 100 > -DRAWDOWN_GATE) continue
      if (i - last < COOLDOWN_M) continue
      last = i
      const start = bars[i].c
      const fwd = bars.slice(i + 1, i + 1 + FORWARD_M).map((b) => b.c)
      let tr = 0
      for (let k = 1; k < fwd.length; k += 1) if (fwd[k] < fwd[tr]) tr = k
      const hold: Record<number, number> = {}
      for (const h of [6, 12, 24]) hold[h] = h - 1 < fwd.length ? ((fwd[h - 1] - start) / start) * 100 : NaN
      let rec: number | null = null
      for (let k = tr; k < fwd.length; k += 1) if (fwd[k] >= start) { rec = k - tr; break }
      eps.push({
        ticker,
        startMonth: bars[i].m.slice(0, 7),
        monthsToTrough: tr + 1,
        extraDropPct: ((fwd[tr] - start) / start) * 100,
        hold,
        monthsToRecover: rec,
        stillFalling: tr >= fwd.length - 2,
      })
    }
  }

  const show = (label: string, es: Ep[]) => {
    const n = es.length
    console.log(`\n▶ ${label} — ${n}건 (${new Set(es.map((e) => e.ticker)).size}종목)${n < 30 ? '  ⚠ 표본 부족' : ''}`)
    if (n === 0) return
    console.log(
      `  저점까지 ${d0(median(es.map((e) => e.monthsToTrough)))}개월` +
        ` (25%분위 ${d0(quantile(es.map((e) => e.monthsToTrough), 0.25))}` +
        ` · 75%분위 ${d0(quantile(es.map((e) => e.monthsToTrough), 0.75))})` +
        ` · 2년 뒤에도 바닥 못 찍음 ${((es.filter((e) => e.stillFalling).length / n) * 100).toFixed(0)}%`,
    )
    console.log(
      `  추가 하락폭 중간값 ${pct(median(es.map((e) => e.extraDropPct)))}` +
        ` (25%분위 ${pct(quantile(es.map((e) => e.extraDropPct), 0.25))})`,
    )
    console.log(
      `  그냥 들고: ${[6, 12, 24]
        .map((h) => {
          const v = es.map((e) => e.hold[h]).filter((x) => Number.isFinite(x))
          return v.length >= 10 ? `${h}개월 ${pct(median(v))}` : null
        })
        .filter(Boolean)
        .join(' · ')}`,
    )
    const rec = es.filter((e) => e.monthsToRecover !== null)
    console.log(
      `  저점 이후 시작가 회복: ${((rec.length / n) * 100).toFixed(0)}%` +
        ` · 중간값 ${d0(median(rec.map((e) => e.monthsToRecover as number)))}개월`,
    )
    const years = new Map<string, number>()
    for (const e of es) years.set(e.startMonth.slice(0, 4), (years.get(e.startMonth.slice(0, 4)) ?? 0) + 1)
    console.log(
      `  시작 연도별: ${[...years.entries()].sort().map(([y, c]) => `${y} ${c}`).join(' · ')}`,
    )
  }

  line('=')
  console.log(`2부 — 월봉 ${FORWARD_M}개월 추적 (사이클 하강기가 창에 들어온다)`)
  line('=')
  const semi = eps.filter((e) => SEMI.has(e.ticker))
  show('전체', eps)
  show('반도체', semi)
  for (const t of DIAG) {
    const own = eps.filter((e) => e.ticker === t)
    if (own.length > 0) {
      console.log(
        `\n  · ${t} ${nameOf.get(t) ?? ''} — ${own.length}건: ` +
          own
            .map(
              (e) =>
                `${e.startMonth}(저점 ${e.monthsToTrough}개월·${pct(e.extraDropPct)}` +
                `${e.monthsToRecover === null ? '·미회복' : `·회복 ${e.monthsToRecover}개월`})`,
            )
            .join(' '),
      )
    } else {
      console.log(`\n  · ${t} ${nameOf.get(t) ?? ''} — 에피소드 0건`)
    }
  }

  line('=')
  console.log('※ 월 해상도라 달 안의 저점은 못 본다 — "저점까지 N개월"은 ±1개월 눈금이다.')
  console.log('※ 생존 편향은 **일봉판보다 더 크다** — 창이 길수록 그 사이 상장폐지된 종목이 더 많이 빠진다.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
