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

/**
 * **반도체를 따로 묶는 목록.** DB(`stock_universe`)에는 GICS **섹터**까지만 있어서
 * (`sector` 컬럼 하나) 반도체와 소프트웨어가 `Information Technology` 하나에 같이
 * 들어간다. 그런데 둘은 하락·회복 양상이 다를 이유가 분명하다 — 반도체는 메모리·
 * capex 사이클을 타고, 구독형 소프트웨어는 매출이 반복된다. 섞어 재면 사용자가 물은
 * "반도체는 어떤가"에 답하지 못한다.
 *
 * 그래서 **티커로 직접 묶는다.** 손으로 적은 목록이라 시간이 지나면 낡는다는 것을
 * 알고 쓴다(이 저장소가 경계하는 상수다). 대신 ① 리서치 스크립트에만 두고 화면·
 * 파이프라인 판정에는 안 쓰며, ② 실행할 때마다 **실제로 에피소드가 잡힌 티커 수를
 * 같이 찍어** 목록이 비거나 어긋나면 출력에서 바로 드러나게 한다.
 *
 * 국내는 유니버스가 코스피뿐이라(`universe_kr`) 반도체 표본이 구조적으로 얇다 —
 * 코스닥 소부장(이오테크닉스·리노공업·원익IPS 등)이 통째로 빠진다. 답은 미국 쪽에서 나온다.
 */
const SEMI_DESIGN = new Set([
  // 미국 — 설계·제조(팹리스/IDM/파운드리)
  'NVDA', 'AMD', 'INTC', 'MU', 'AVGO', 'QCOM', 'TXN', 'ADI', 'MCHP', 'NXPI',
  'ON', 'SWKS', 'QRVO', 'MPWR', 'MRVL', 'WOLF', 'LSCC', 'SLAB', 'SIMO', 'AMKR',
  'TSM', 'STM', 'UMC', 'GFS', 'ALGM', 'SITM', 'RMBS', 'CRUS', 'SYNA', 'POWI',
  'DIOD', 'MTSI', 'AOSL', 'VSH', 'NVTS', 'INDI',
  // 국내 — 코스피 상장분만 (코스닥은 유니버스에 없다)
  '000660', '005930', '042700', '000990',
])
const SEMI_EQUIP = new Set([
  'AMAT', 'LRCX', 'KLAC', 'ASML', 'TER', 'ENTG', 'MKSI', 'ONTO', 'ACMR', 'UCTT',
  'COHU', 'FORM', 'AEIS', 'CAMT', 'PLAB', 'AXT', 'NVMI', 'KLIC', 'ICHR',
])
const isSemi = (t: string) => SEMI_DESIGN.has(t) || SEMI_EQUIP.has(t)

/**
 * 경기민감 ↔ 경기방어. 사용자의 "사이클릭한 테마는 따로 봐야 하지 않나"를 섹터
 * 수준에서도 확인하려고 둔다. GICS 분류의 통상적인 구분을 그대로 쓴다.
 */
const CYCLICAL = new Set([
  'Energy', 'Materials', 'Industrials', 'Consumer Discretionary', 'Financials', 'Real Estate',
])
const DEFENSIVE = new Set(['Consumer Staples', 'Health Care', 'Utilities'])

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
  /**
   * 저점 이후 수익률(%). **사후편향이 있다** — 1년치를 다 보고 가장 낮은 날을
   * 고른 뒤 거기서부터 재는 값이라 양수가 안 나올 수가 없다. 실전에서 그 바닥을
   * 미리 알 방법은 없으므로 "완벽하게 바닥을 잡았다면 받았을 상한"으로만 읽는다.
   */
  afterTrough: Record<number, number>
  /**
   * **사후편향 없는 값** — 그냥 그날 사서 들고 있었을 때의 수익률.
   * 사람이 실제로 받을 수 있는 숫자는 이쪽이다.
   */
  holdFrom: Record<number, number>
  /**
   * 저점을 찍은 뒤 **시작가로 돌아오기까지** 걸린 거래일 수(못 돌아오면 null).
   * 처음엔 "시작가를 한 번이라도 넘은 날"로 쟀다가 중간값 3거래일이 나왔다 —
   * 하락일 다음 날 살짝 반등만 해도 '회복'으로 세 버린 것이다. 바닥을 지나야
   * 회복이라고 부를 수 있으므로 **저점 이후**로 한정한다.
   */
  daysToRecover: number | null
  /** 저점이 관측 창 **끝자락**(마지막 20일)에 있었나 = 1년 뒤에도 여전히 빠지는 중. */
  stillFalling: boolean
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

  // 일봉이 있는 종목 — **여러 시점의 하루치 합집합**으로 만든다.
  // 처음에 최신 하루치만 썼다가 401종목밖에 안 잡혔다(실제로는 946종목). 그날 봉이
  // 아직 안 들어온 종목과 그 사이 수집이 끊긴 종목이 통째로 빠진 것이다.
  // `backtestEtfStage.ts`·`dump_pullback_signals.py`가 쓰는 앵커 방식과 같다.
  const latest = await db
    .from('stock_price_history')
    .select('date')
    .eq('market', MARKET)
    .order('date', { ascending: false })
    .limit(1)
  const latestDay = latest.data?.[0]?.date
  if (!latestDay) throw new Error('일봉이 없다')
  const found = new Set<string>()
  for (const back of [0, 120, 240, 360, 480]) {
    const anchor = new Date(latestDay)
    anchor.setDate(anchor.getDate() - back)
    const dayRows = await db
      .from('stock_price_history')
      .select('date')
      .eq('market', MARKET)
      .lte('date', anchor.toISOString().slice(0, 10))
      .order('date', { ascending: false })
      .limit(1)
    const day = dayRows.data?.[0]?.date
    if (!day) continue
    const rows = await fetchAll<{ ticker: string }>((f, t) =>
      db.from('stock_price_history').select('ticker').eq('market', MARKET).eq('date', day).range(f, t),
    )
    for (const r of rows) found.add(r.ticker)
    console.log(`  앵커 ${day}: ${rows.length}종목 (누적 ${found.size})`)
  }
  const tickers = [...found].sort()
  console.log(`일봉 보유 ${tickers.length}종목\n`)

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
        const holdFrom: Record<number, number> = {}
        for (const h of [60, 120, 250]) {
          const at = troughRel + h
          afterTrough[h] = at < fwd.length ? ((fwd[at] - trough) / trough) * 100 : NaN
          holdFrom[h] = h - 1 < fwd.length ? ((fwd[h - 1] - startPrice) / startPrice) * 100 : NaN
        }
        // 회복은 **저점을 지난 뒤**부터 센다 (위 docstring 참조).
        let daysToRecover: number | null = null
        for (let k = troughRel; k < fwd.length; k += 1) {
          if (fwd[k] >= startPrice) {
            daysToRecover = k - troughRel
            break
          }
        }
        episodes.push({
          ticker,
          daysToTrough: troughRel + 1,
          extraDropPct: ((trough - startPrice) / startPrice) * 100,
          afterTrough,
          holdFrom,
          daysToRecover,
          stillFalling: troughRel >= fwd.length - 20,
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
  const bySector = new Map<string, Episode[]>()
  for (const e of episodes) {
    const sec = sectorOf.get(e.ticker) ?? '미분류'
    const b = bySector.get(sec)
    if (b) b.push(e)
    else bySector.set(sec, [e])
  }
  const sectorRank = [...bySector.entries()].sort((a, b) => b[1].length - a[1].length)

  const semiDesign = episodes.filter((e) => SEMI_DESIGN.has(e.ticker))
  const semiEquip = episodes.filter((e) => SEMI_EQUIP.has(e.ticker))
  const itAll = episodes.filter((e) => sectorOf.get(e.ticker) === 'Information Technology')
  const groups: [string, Episode[]][] = [
    ['전체', episodes],
    [`대형주 시총상위${LARGE_CAP_N}`, episodes.filter((e) => largeCaps.has(e.ticker))],
    // ── 사용자 가설 검증: 반도체를 소프트웨어와 섞어 보면 안 되는가 ──────
    // 세 줄을 나란히 둬야 답이 나온다. 반도체 두 줄이 'IT − 반도체' 줄과 비슷하면
    // 따로 묶을 이유가 없는 것이고, 다르면 섹터로 뭉뚱그린 앞 측정이 틀린 것이다.
    ['반도체 설계·제조', semiDesign],
    ['반도체 장비·소재', semiEquip],
    ['IT 중 반도체 제외(소프트웨어 등)', itAll.filter((e) => !isSemi(e.ticker))],
    ['반도체 전체(설계+장비)', episodes.filter((e) => isSemi(e.ticker))],
    ['경기민감 섹터 합', episodes.filter((e) => CYCLICAL.has(sectorOf.get(e.ticker) ?? ''))],
    ['경기방어 섹터 합', episodes.filter((e) => DEFENSIVE.has(sectorOf.get(e.ticker) ?? ''))],
    // 섹터는 **건수 상위 8개를 전부** 찍는다. 처음에 30건 미만을 통째로 가렸더니
    // 정작 물어본 반도체·대형주가 출력에서 사라졌다 — 표본이 적으면 적다고
    // 적을 일이지, 질문에 답을 안 하면 안 된다.
    ...sectorRank.slice(0, 8).map(([sec, es]) => [`섹터: ${sec}`, es] as [string, Episode[]]),
  ]

  line('=')
  console.log('1부 — 물타기 상황에 들어선 뒤 실제로 벌어진 일')
  console.log(`  관측 시작 = 120봉 고점 대비 −${DRAWDOWN_GATE}% 이하인 날 (종목당 ${EPISODE_COOLDOWN}일 쿨다운)`)
  console.log('  ※ "저점 이후"는 **사후편향**이 있다(1년을 다 보고 최저일을 고른 값).')
  console.log('    실제로 받을 수 있는 숫자는 "그냥 들고 있었을 때" 쪽이다.')
  line('=')
  console.log(`\n섹터별 에피소드 수: ${sectorRank.map(([k, v]) => `${k} ${v.length}`).join(' · ')}`)
  // 손으로 적은 반도체 목록이 실제로 걸렸는지 — 0이면 목록이 낡았거나 시장이 안 맞는 것이다.
  const semiHit = [...new Set(episodes.filter((e) => isSemi(e.ticker)).map((e) => e.ticker))].sort()
  console.log(
    `\n반도체 목록 적중: ${semiHit.length}종목 / 목록 ${SEMI_DESIGN.size + SEMI_EQUIP.size}개` +
      ` → ${semiHit.join(', ') || '(없음)'}`,
  )

  for (const [label, es] of groups) {
    const n = es.length
    const tick = new Set(es.map((e) => e.ticker)).size
    console.log(`\n▶ ${label} — ${n}건 (${tick}종목)${n < 30 ? '  ⚠ 표본 부족, 참고만' : ''}`)
    if (n === 0) continue
    console.log(
      `  저점까지 ${d0(median(es.map((e) => e.daysToTrough)))}거래일` +
        ` (25%분위 ${d0(quantile(es.map((e) => e.daysToTrough), 0.25))}` +
        ` · 75%분위 ${d0(quantile(es.map((e) => e.daysToTrough), 0.75))})` +
        ` · **1년 뒤에도 바닥을 못 찍은 비율 ${((es.filter((e) => e.stillFalling).length / n) * 100).toFixed(0)}%**`,
    )
    console.log(
      `  저점의 추가 하락폭 중간값 ${pct(median(es.map((e) => e.extraDropPct)))}` +
        ` (25%분위 ${pct(quantile(es.map((e) => e.extraDropPct), 0.25))}` +
        ` · 75%분위 ${pct(quantile(es.map((e) => e.extraDropPct), 0.75))})`,
    )
    const hold = [60, 120, 250]
      .map((h) => {
        const v = es.map((e) => e.holdFrom[h]).filter((x) => Number.isFinite(x))
        return v.length >= 20 ? `${h}일 ${pct(median(v))}` : null
      })
      .filter(Boolean)
    console.log(`  **그냥 들고 있었을 때(사후편향 없음)**: ${hold.join(' · ') || '표본 부족'}`)
    const aft = [60, 120]
      .map((h) => {
        const v = es.map((e) => e.afterTrough[h]).filter((x) => Number.isFinite(x))
        return v.length >= 20 ? `${h}일 ${pct(median(v))}(${v.length}건)` : null
      })
      .filter(Boolean)
    console.log(`  저점을 완벽히 잡았다면(상한): ${aft.join(' · ') || '표본 부족'}`)
    const rec = es.filter((e) => e.daysToRecover !== null)
    console.log(
      `  저점 이후 시작가 회복: ${((rec.length / n) * 100).toFixed(0)}%` +
        ` · 걸린 일수 중간값 ${d0(median(rec.map((e) => e.daysToRecover as number)))}거래일` +
        ` (75%분위 ${d0(quantile(rec.map((e) => e.daysToRecover as number), 0.75))})`,
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
