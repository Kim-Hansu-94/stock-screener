/**
 * **"이제 하락이 멈추고 상승으로 돌아섰다"를 잡는 매수 트리거 후보들을 재는 리서치 스크립트.**
 *
 * 왜 이걸 따로 만드나 — `backtestSupportSignals.ts`는 이걸 찾을 수 없다
 * ------------------------------------------------------------------
 * 그쪽은 **10거래일마다 무작정 샘플링**해서 "그날 조건이 켜져 있었나"를 봤다. 그건 *상태*를
 * 재는 설계다. 그런데 매수 신호는 상태가 아니라 **사건**이다 — "오늘 20일선을 회복했다",
 * "오늘 직전 반등 고점을 뚫었다"처럼 그날 처음 일어난 일이어야 "이제 사라"가 된다.
 * 사건을 재려면 **신호가 뜬 날만 모아서** 그 뒤를 봐야 한다. 그래서 설계를 바꿨다:
 *
 *   - 모든 거래일을 하루씩 걸으며 트리거가 **오늘 처음 켜졌는지**를 본다(상태가 아니라 전이).
 *   - 하락 국면에서만 센다 — 신고가 행진 중에 20일선을 회복하는 건 '전환'이 아니다.
 *   - **진입가는 신호 당일 종가가 아니라 다음 거래일 시가다.** 신호는 종가가 나온 뒤에야
 *     계산되므로 그 가격엔 살 수 없다. `docs/backtest-guide.md`가 지적한 그 함정이고,
 *     종가로 재면 반등 확인형 조건은 다음날 갭상승만큼 공짜 수익을 얻는다.
 *   - **얼마나 더 아팠는지(MAE)도 같이 잰다.** 물타기는 진입 후 추가 하락이 치명적이라
 *     "60일 뒤 수익률"만으로는 쓸 수 있는 신호인지 알 수 없다.
 *   - **기준선과 비교한다**: 같은 하락 국면의 *아무 날*에 사는 것보다 나은가. 이걸 안 보면
 *     "강세장이라 다 올랐다"를 신호의 실력으로 착각한다.
 *
 * 시장 효과 제거(날짜별 중앙값 차감)는 그대로 유지한다 — `backtestEtfStage.ts`가 그걸
 * 빼먹고 세 번 다른 결론을 낸 전례가 있다.
 *
 * 실행: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
 *       node --import ./research/resolveTsImports.mjs research/backtestTurnSignals.ts
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
/** 하락 국면 판정 — 120봉 고점 대비 이만큼(%) 이상 빠져 있어야 '전환'을 논할 수 있다. */
const DRAWDOWN_GATE = Number(process.env.DRAWDOWN_GATE ?? 15)
const HORIZONS = [20, 60]
const WARMUP = 130
/** 같은 트리거가 이 기간(거래일) 안에 다시 켜지면 같은 움직임으로 보고 세지 않는다. */
const COOLDOWN = Number(process.env.COOLDOWN ?? 10)
const PAGE = 1000

// ── 지표: 종목당 한 번만 계산해 배열로 들고 쓴다 ─────────────────────────────
function sma(v: number[], w: number): (number | null)[] {
  const out: (number | null)[] = new Array(v.length).fill(null)
  let sum = 0
  for (let i = 0; i < v.length; i += 1) {
    sum += v[i]
    if (i >= w) sum -= v[i - w]
    if (i >= w - 1) out[i] = sum / w
  }
  return out
}

function rsi(v: number[], w = 14): (number | null)[] {
  const out: (number | null)[] = new Array(v.length).fill(null)
  if (v.length < w + 1) return out
  let g = 0
  let l = 0
  for (let i = 1; i <= w; i += 1) {
    const d = v[i] - v[i - 1]
    if (d >= 0) g += d
    else l -= d
  }
  g /= w
  l /= w
  out[w] = l === 0 ? 100 : 100 - 100 / (1 + g / l)
  for (let i = w + 1; i < v.length; i += 1) {
    const d = v[i] - v[i - 1]
    g = (g * (w - 1) + (d > 0 ? d : 0)) / w
    l = (l * (w - 1) + (d < 0 ? -d : 0)) / w
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l)
  }
  return out
}

const maxOf = (xs: number[]) => xs.reduce((a, b) => (b > a ? b : a), -Infinity)
const minOf = (xs: number[]) => xs.reduce((a, b) => (b < a ? b : a), Infinity)

interface Ind {
  close: number[]
  open: number[]
  high: number[]
  low: number[]
  vol: number[]
  sma20: (number | null)[]
  sma60: (number | null)[]
  rsi14: (number | null)[]
}

/**
 * 트리거 하나. `fires(ind, i)`는 "**i일에 처음** 이 사건이 일어났는가"를 돌려준다.
 * 전부 i 이하의 데이터만 본다 — 미래를 보면 백테스트가 조용히 거짓말을 한다.
 */
interface Trigger {
  id: string
  label: string
  why: string
  fires(d: Ind, i: number): boolean
}

/** 최근 `look`봉에서 가장 낮은 저점의 인덱스. */
function lowestIdx(d: Ind, i: number, look: number): number {
  let best = i
  for (let k = Math.max(0, i - look + 1); k <= i; k += 1) if (d.low[k] < d.low[best]) best = k
  return best
}

const TRIGGERS: Trigger[] = [
  {
    id: 'sma20Reclaim',
    label: '20일선 회복 (첫날)',
    why: '하락 중이던 종목이 단기 추세선을 되찾은 날',
    fires: (d, i) => {
      const a = d.sma20[i]
      const b = d.sma20[i - 1]
      if (a === null || b === null) return false
      return d.close[i] > a && d.close[i - 1] <= b
    },
  },
  {
    id: 'swingBreak',
    label: '구조 전환 (직전 반등고점 돌파)',
    why: '다우 이론의 추세 전환 정의 — 저점 이후 만든 첫 고점을 종가로 뚫은 날',
    fires: (d, i) => {
      const L = lowestIdx(d, i, 60)
      // 저점이 너무 최근이면(바닥을 다지지도 않았으면) 전환이라 부를 수 없다.
      if (i - L < 5) return false
      const peak = maxOf(d.high.slice(L + 1, i))
      if (!Number.isFinite(peak)) return false
      return d.close[i] > peak && d.close[i - 1] <= peak
    },
  },
  {
    id: 'followThrough',
    label: '팔로스루 데이 (저점 후 4~15일)',
    why: "오닐의 FTD — 저점 며칠 뒤 거래량 늘며 크게 오른 날이 바닥 확인 신호라는 규칙",
    fires: (d, i) => {
      const L = lowestIdx(d, i, 60)
      const gap = i - L
      if (gap < 4 || gap > 15) return false
      const chg = ((d.close[i] - d.close[i - 1]) / d.close[i - 1]) * 100
      return chg >= 1.5 && d.vol[i] > d.vol[i - 1]
    },
  },
  {
    id: 'goldenCross',
    label: '20일선이 60일선 상향 돌파',
    why: '중기 추세 전환의 고전적 신호',
    fires: (d, i) => {
      const a20 = d.sma20[i]
      const a60 = d.sma60[i]
      const p20 = d.sma20[i - 1]
      const p60 = d.sma60[i - 1]
      if (a20 === null || a60 === null || p20 === null || p60 === null) return false
      return a20 > a60 && p20 <= p60
    },
  },
  {
    id: 'volumeDryPop',
    label: '거래량 말랐다가 양봉에 터짐',
    why: '매도 소진(거래량 고갈) 뒤 매수세가 처음 들어온 날 — VCP의 수축→확장',
    fires: (d, i) => {
      if (i < 61) return false
      // **고갈은 오늘을 뺀 구간으로 재야 한다.** 오늘 거래량이 터지는 게 이 트리거의 핵심인데
      // 그 날을 '최근 10일'에 넣으면 터진 양이 평균을 올려 고갈 판정을 스스로 깨 버린다
      // (합성 데이터로 확인: 그래서 한 번도 안 켜졌다).
      const dry10 = d.vol.slice(i - 10, i).reduce((a, b) => a + b, 0) / 10
      const prior40 = d.vol.slice(i - 50, i - 10).reduce((a, b) => a + b, 0) / 40
      const avg20 = d.vol.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20
      if (prior40 <= 0 || avg20 <= 0) return false
      const dried = dry10 < prior40 * 0.7
      return dried && d.vol[i] > avg20 * 1.5 && d.close[i] > d.open[i]
    },
  },
  {
    id: 'higherLowBreak',
    label: '저점 높이기 + 그 사이 고점 돌파',
    why: '바닥을 한 번 더 확인하고(저점 높이기) 그 박스를 위로 깬 날 — 둘을 함께 요구',
    fires: (d, i) => {
      const L1 = lowestIdx(d, i, 60)
      if (i - L1 < 10) return false
      // L1 이후 구간에서 두 번째 저점(되눌림)을 찾는다.
      const peakIdx = (() => {
        let b = L1 + 1
        for (let k = L1 + 1; k < i; k += 1) if (d.high[k] > d.high[b]) b = k
        return b
      })()
      if (peakIdx <= L1 || i - peakIdx < 3) return false
      const pullbackLow = minOf(d.low.slice(peakIdx + 1, i + 1))
      if (!Number.isFinite(pullbackLow) || pullbackLow <= d.low[L1]) return false
      return d.close[i] > d.high[peakIdx] && d.close[i - 1] <= d.high[peakIdx]
    },
  },
  {
    id: 'rsi50Cross',
    label: 'RSI가 과매도 뒤 50 상향 돌파',
    why: '모멘텀이 중립선을 되찾은 날 — 과매도(35 이하)를 거쳤을 때만',
    fires: (d, i) => {
      const a = d.rsi14[i]
      const b = d.rsi14[i - 1]
      if (a === null || b === null) return false
      if (!(a > 50 && b <= 50)) return false
      const win = d.rsi14.slice(Math.max(0, i - 30), i + 1).filter((x): x is number => x !== null)
      return win.length > 0 && minOf(win) <= 35
    },
  },
]

interface Obs {
  trig: string
  ticker: string
  date: string
  fwd: Record<number, number>
  adj: Record<number, number>
  /** 진입 후 최악의 추가 하락(%) — 물타기에서 실제로 아픈 숫자 */
  mae: Record<number, number>
}

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

const median = (xs: number[]) => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const pct = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—')

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
    const rows = await fetchAll<{ ticker: string }>((f, t) =>
      db.from('stock_price_history').select('ticker').eq('market', MARKET).eq('date', day).range(f, t),
    )
    for (const r of rows) found.add(r.ticker)
  }
  return [...found]
}

function line(label: string, rows: number[], maes: number[]): string {
  if (rows.length === 0) return `  ${label.padEnd(30)} 표본 없음`
  const win = (rows.filter((r) => r > 0).length / rows.length) * 100
  return (
    `  ${label.padEnd(30)}${String(rows.length).padStart(7)}건` +
    `${pct(median(rows)).padStart(9)}(중앙)` +
    `${pct(mean(rows)).padStart(9)}(평균)` +
    `${win.toFixed(1).padStart(6)}% 승률` +
    `${pct(median(maes)).padStart(9)} 최대낙폭(중앙)`
  )
}

async function main() {
  console.log(
    `시장 ${MARKET} · 하락국면 게이트 −${DRAWDOWN_GATE}% · 진입 = **신호 다음 거래일 시가** · 지평선 ${HORIZONS.join('/')}일`,
  )
  const tickers = await tickersWithBars()
  console.log(`일봉 보유 ${tickers.length}종목\n`)

  const all: Obs[] = []
  // 기준선: 같은 하락 국면의 '아무 날'에 사면 어땠나 (신호가 이걸 못 넘으면 쓸모없다)
  const base: Obs[] = []
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
    if (scanned % 100 === 0) console.log(`  ...${scanned}/${tickers.length}종목 (신호 ${all.length}건)`)
    const maxH = Math.max(...HORIZONS)
    if (bars.length < WARMUP + maxH + 2) continue

    const d: Ind = {
      close: bars.map((b) => b.close),
      open: bars.map((b) => b.open),
      high: bars.map((b) => b.high),
      low: bars.map((b) => b.low),
      vol: bars.map((b) => b.volume),
      sma20: sma(bars.map((b) => b.close), 20),
      sma60: sma(bars.map((b) => b.close), 60),
      rsi14: rsi(bars.map((b) => b.close), 14),
    }

    // 트리거별 '마지막으로 켜진 인덱스' — 쿨다운 판정용(종목마다 새로 시작).
    const lastFire = new Map<string, number>()

    for (let i = WARMUP; i < bars.length - maxH - 1; i += 1) {
      // 하락 국면인가 — 120봉 고점 대비 충분히 빠져 있어야 '전환'을 논할 수 있다.
      const hi = maxOf(d.high.slice(Math.max(0, i - 119), i + 1))
      const ddPct = ((d.close[i] - hi) / hi) * 100
      if (ddPct > -DRAWDOWN_GATE) continue

      // 진입은 **다음 거래일 시가**. 신호는 종가 뒤에 나오므로 당일 종가엔 살 수 없다.
      const entry = d.open[i + 1]
      if (!(entry > 0)) continue

      const mk = (trig: string): Obs => {
        const fwd: Record<number, number> = {}
        const mae: Record<number, number> = {}
        for (const h of HORIZONS) {
          fwd[h] = ((d.close[i + 1 + h] - entry) / entry) * 100
          mae[h] = ((minOf(d.low.slice(i + 1, i + 2 + h)) - entry) / entry) * 100
        }
        return { trig, ticker, date: bars[i].date, fwd, adj: {}, mae }
      }

      base.push(mk('__base__'))
      for (const t of TRIGGERS) {
        if (!t.fires(d, i)) continue
        // **쿨다운이 없으면 한 번의 상승을 수십 번 센다.** 꾸준히 오르는 구간에서는
        // '직전 고점'이 매일 갱신돼 돌파 조건이 날마다 다시 참이 된다(합성 데이터에서
        // 한 번의 V자 회복을 swingBreak가 19번 셌다). 그러면 표본 수가 부풀고 같은
        // 움직임이 중복 집계된다.
        const last = lastFire.get(t.id)
        if (last !== undefined && i - last < COOLDOWN) continue
        lastFire.set(t.id, i)
        all.push(mk(t.id))
      }
    }
  }

  // 시장 효과 제거 — 기준선 전체의 날짜별 중앙값을 뺀다(같은 하락 국면 모집단 기준).
  for (const h of HORIZONS) {
    const byDate = new Map<string, number[]>()
    for (const o of base) {
      if (!byDate.has(o.date)) byDate.set(o.date, [])
      byDate.get(o.date)!.push(o.fwd[h])
    }
    const med = new Map<string, number>()
    for (const [k, xs] of byDate) med.set(k, median(xs))
    for (const o of [...base, ...all]) o.adj[h] = o.fwd[h] - (med.get(o.date) ?? 0)
  }

  for (const h of HORIZONS) {
    console.log(`\n${'='.repeat(104)}`)
    console.log(`${h}거래일 뒤 — 시장 효과 제거 (같은 하락 국면 날짜별 중앙값 차감)`)
    console.log('='.repeat(104))
    console.log(
      line(
        '[기준선] 하락국면 아무 날',
        base.map((o) => o.adj[h]),
        base.map((o) => o.mae[h]),
      ),
    )
    console.log(`  ${'─'.repeat(100)}`)
    const scored = TRIGGERS.map((t) => {
      const rows = all.filter((o) => o.trig === t.id)
      return { t, rows, med: median(rows.map((o) => o.adj[h])) }
    }).sort((a, b) => (Number.isFinite(b.med) ? b.med : -99) - (Number.isFinite(a.med) ? a.med : -99))
    for (const { t, rows } of scored) {
      const tk = new Set(rows.map((o) => o.ticker)).size
      console.log(
        line(
          `${t.label} (${tk}종목)`,
          rows.map((o) => o.adj[h]),
          rows.map((o) => o.mae[h]),
        ),
      )
    }
  }

  console.log(`\n${'='.repeat(104)}`)
  console.log('※ 진입가는 신호 다음 거래일 시가다 — 당일 종가로 재면 반등 확인형 조건이 갭상승분을')
  console.log('  공짜로 먹어 성적이 부풀려진다(docs/backtest-guide.md의 알려진 한계 2번).')
  console.log('※ 최대낙폭(MAE)은 진입 후 그 지평선 안에서 가장 아팠던 지점이다 — 물타기에서는')
  console.log('  "결국 올랐다"보다 "그 사이 얼마나 더 빠졌나"가 버틸 수 있는지를 정한다.')
  console.log('※ 생존 편향은 못 뺀다 — 유니버스가 오늘 기준이다.')
  console.log('※ 신호가 기준선을 못 넘으면 그 신호는 쓸모가 없다. 기준선과 반드시 같이 읽을 것.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
