// 성적표(app/history)·포지션(app/positions) 페이지 — 과거 추천의 결과 추적용 쿼리.
import { cacheLife, cacheTag } from 'next/cache'
import { createServerSupabaseClient } from '../supabase'
import { computeStopTarget, filterBarsAsOf, type PriceBar } from '../risk'
import { fetchPriceRowsPaged, SCREENER_CACHE_TAG } from './shared'
import { resolveTrade, type ResolvedTrade } from '../scorecard'
import { resolvePatternRec, type PatternFeatures, type ResolvedPatternRec } from '../patternScorecard'
import { getUniverseNameMap } from './universe'
import type { DayReturn, Market, PriceHistoryRow, ScreenedStockPerf, ScreenedStockWithRisk } from '../types'

export async function getRegimesInRange(
  market: Market,
  cutoffStr: string,
): Promise<Record<string, string>> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()
  const { data } = await supabase
    .from('market_regime')
    .select('date, regime')
    .eq('market', market)
    .gte('date', cutoffStr)
    .order('date', { ascending: false })

  const map: Record<string, string> = {}
  for (const row of (data ?? []) as { date: string; regime: string }[]) {
    map[row.date] = row.regime
  }
  return map
}

export async function getScreenedStockPerformance(
  market: Market,
  days = 30,
): Promise<ScreenedStockPerf[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)

  const supabase = createServerSupabaseClient()
  const today = new Date().toISOString().slice(0, 10)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  // Past recommendations only (exclude today since day1 would be today's close, not yet settled)
  // passed=true만: 근접 후보(참고용)는 추천이 아니므로 수익률 집계에서 제외
  const { data: recs, error: recsError } = await supabase
    .from('screened_stocks')
    .select('date, market, ticker, name, sector, close')
    .eq('market', market)
    .eq('passed', true)
    .lt('date', today)
    .gte('date', cutoffStr)
    .order('date', { ascending: false })

  if (recsError) throw new Error(recsError.message)
  if (!recs?.length) return []

  const tickers = [...new Set(recs.map((r: { ticker: string }) => r.ticker))]
  const oldestDate = (recs as { date: string }[]).at(-1)!.date
  const nameKrMap = await getUniverseNameMap(market, tickers)

  // Extend 150 calendar days before oldest rec date for ATR + resistance-level calculation
  // (covers the ~90-trading-day pivot-high lookback plus holiday/weekend buffer)
  const prePeriodDate = new Date(oldestDate)
  prePeriodDate.setDate(prePeriodDate.getDate() - 150)
  const prePeriodStr = prePeriodDate.toISOString().slice(0, 10)

  const priceData = await fetchPriceRowsPaged<PriceBar & { ticker: string }>(
    market,
    tickers,
    'ticker, date, high, low, close',
    prePeriodStr,
  )

  const priceMap: Record<string, PriceBar[]> = {}
  for (const row of priceData) {
    priceMap[row.ticker] ??= []
    priceMap[row.ticker].push({ date: row.date, high: row.high, low: row.low, close: row.close })
  }

  return (recs as { date: string; market: string; ticker: string; name: string; sector: string; close: number }[]).map(
    (rec) => {
      const allBars = priceMap[rec.ticker] ?? []
      const future = allBars.filter((p) => p.date > rec.date)
      const preBars = allBars.filter((p) => p.date <= rec.date)

      const makeReturn = (i: number): DayReturn | null => {
        const row = future[i]
        if (!row) return null
        return { date: row.date, close: row.close, returnPct: ((row.close - rec.close) / rec.close) * 100 }
      }

      const { stop, target, riskReward } = computeStopTarget(preBars, rec.close)

      return {
        date: rec.date,
        market: rec.market as Market,
        ticker: rec.ticker,
        name: rec.name,
        name_kr: nameKrMap[rec.ticker],
        sector: rec.sector,
        entryPrice: rec.close,
        day1: makeReturn(0),
        day2: makeReturn(1),
        day3: makeReturn(2),
        stop,
        target,
        riskReward,
      }
    },
  )
}

export async function getPullbackScreenerWithRisk(
  market: Market,
): Promise<ScreenedStockWithRisk[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)

  const supabase = createServerSupabaseClient()

  // Get the latest screened date for this market
  const { data: latestRow } = await supabase
    .from('screened_stocks')
    .select('date')
    .eq('market', market)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!latestRow) return []
  const latestDate = (latestRow as { date: string }).date

  const { data: stocks, error } = await supabase
    .from('screened_stocks')
    .select('date, market, ticker, name, sector, close, rsi')
    .eq('market', market)
    .eq('date', latestDate)

  if (error) throw new Error(error.message)
  if (!stocks?.length) return []

  const tickers = (stocks as { ticker: string }[]).map((s) => s.ticker)
  const nameKrMap = await getUniverseNameMap(market, tickers)

  // 150 days of daily OHLCV — used for both ATR/resistance calculation and chart display
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 150)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const priceData = await fetchPriceRowsPaged<PriceHistoryRow>(
    market,
    tickers,
    'ticker, market, date, open, high, low, close, volume',
    cutoffStr,
  )

  const priceMap: Record<string, PriceHistoryRow[]> = {}
  for (const row of priceData) {
    priceMap[row.ticker] ??= []
    priceMap[row.ticker].push(row)
  }

  return (stocks as { date: string; market: string; ticker: string; name: string; sector: string; close: number; rsi: number }[]).map(
    (stock) => {
      const history = priceMap[stock.ticker] ?? []
      const bars: PriceBar[] = history.map((r) => ({
        date: r.date,
        high: r.high,
        low: r.low,
        close: r.close,
      }))

      const entry = stock.close
      const barsAsOfEntry = filterBarsAsOf(bars, stock.date)
      const { stop, target, riskReward } = computeStopTarget(barsAsOfEntry, entry)

      return {
        date: stock.date,
        market: stock.market as Market,
        ticker: stock.ticker,
        name: stock.name,
        name_kr: nameKrMap[stock.ticker],
        sector: stock.sector,
        entryPrice: entry,
        rsi: stock.rsi,
        stop,
        target,
        riskReward,
        history,
      }
    },
  )
}


/**
 * 스크리너 성적 집계용 트레이드 목록.
 *
 * 조회 창이 긴 이유: 판정에 최대 MAX_HOLD_BARS(60거래일 ≈ 3개월)가 걸리므로,
 * 90일 창으로는 판정이 끝난 표본이 거의 안 남는다. 기본 180일이면 앞쪽 90일치가
 * 판정 완료로 쌓이고 뒤쪽은 pending으로 분리된다.
 */
export async function getScorecardTrades(market: Market, days = 180): Promise<ResolvedTrade[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)

  const supabase = createServerSupabaseClient()
  const today = new Date().toISOString().slice(0, 10)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  // passed=true로 거르지 않는다. 전 조건 통과는 드물고(하락장인 날은 '시장 하락장'이
  // 모든 종목에 붙어 그날 전체가 passed=false다) 화면에 실제로 뜨는 건 미달이 가장 적은
  // 상위 후보들이다. 통과분만 집계하면 표본이 거의 없을뿐더러, 정작 매일 보고 있는
  // 종목들의 성적은 알 수 없다. 대신 failed_criteria를 같이 받아 미달 개수별로 나눈다.
  const { data: recs, error } = await supabase
    .from('screened_stocks')
    .select('date, ticker, name, sector, close, failed_criteria')
    .eq('market', market)
    .lt('date', today)
    .gte('date', cutoffStr)
    .order('date', { ascending: false })

  if (error) throw new Error(error.message)
  if (!recs?.length) return []

  // 같은 종목이 눌림목 구간 내내 반복 추천되므로, 창 안의 첫 추천 하나만 트레이드로 센다.
  // (date 내림차순이라 마지막으로 덮이는 값이 가장 이른 날짜다.)
  type Rec = { date: string; ticker: string; name: string; sector: string; close: number; failed_criteria: string[] }
  const firstByTicker = new Map<string, Rec>()
  for (const rec of recs as Rec[]) {
    firstByTicker.set(rec.ticker, rec)
  }
  const picks = [...firstByTicker.values()]
  const tickers = [...firstByTicker.keys()]

  const oldestDate = picks.reduce((min, t) => (t.date < min ? t.date : min), picks[0].date)
  // 손절/목표 계산에 쓰는 피벗 탐색(약 90거래일)을 덮도록 앞쪽으로 150일 더 확보한다.
  const prePeriod = new Date(oldestDate)
  prePeriod.setDate(prePeriod.getDate() - 150)

  const [priceData, regimes, nameKrMap] = await Promise.all([
    fetchPriceRowsPaged<PriceBar & { ticker: string }>(
      market, tickers, 'ticker, date, high, low, close', prePeriod.toISOString().slice(0, 10),
    ),
    getRegimesInRange(market, cutoffStr),
    getUniverseNameMap(market, tickers),
  ])

  const priceMap: Record<string, PriceBar[]> = {}
  for (const row of priceData) {
    priceMap[row.ticker] ??= []
    priceMap[row.ticker].push({ date: row.date, high: row.high, low: row.low, close: row.close })
  }

  const trades: ResolvedTrade[] = []
  for (const pick of picks) {
    const allBars = priceMap[pick.ticker] ?? []
    const preBars = allBars.filter((b) => b.date <= pick.date)
    const { stop, target } = computeStopTarget(preBars, pick.close)
    // 손절/목표를 못 잡는 추천은 애초에 트레이드가 성립하지 않으므로 표본에서 뺀다.
    // 0으로 세면 기댓값이 실제보다 좋아 보인다.
    if (stop === null || target === null) continue

    trades.push(resolveTrade({
      date: pick.date,
      market,
      ticker: pick.ticker,
      name: pick.name,
      nameKr: nameKrMap[pick.ticker],
      sector: pick.sector,
      entry: pick.close,
      stop,
      target,
      futureBars: allBars.filter((b) => b.date > pick.date),
      regime: regimes[pick.date] === 'bull' ? 'bull' : regimes[pick.date] === 'bear' ? 'bear' : null,
      failedCriteria: pick.failed_criteria ?? [],
    }))
  }

  return trades
}


// ── 저점 매집 후보(Gold Standard 패턴) 추천 성적 ────────────────────────────

/** 하루 최대 20행 × 수개월이라 1000행을 넘는다. shared.ts의 절단 주의사항과 같은 이유. */
const PATTERN_REC_PAGE = 1000

/** 추천 월별 일봉 조회 창(달력일). 월 길이 31일 + 60거래일(≈90일) + 여유. */
const PATTERN_PRICE_WINDOW_DAYS = 140

const PATTERN_REC_BASE_COLUMNS = 'recommended_date, ticker, name, sector, entry_price, rank'
const PATTERN_REC_FEATURE_COLUMNS =
  'score, drawdown_pct, days_since_low, vol_ratio, vcp, ma_align, volume_triggered'

type PatternRecRow = {
  recommended_date: string
  ticker: string
  name: string
  sector: string | null
  entry_price: number | null
  rank: number
  score?: number | null
  drawdown_pct?: number | null
  days_since_low?: number | null
  vol_ratio?: number | null
  vcp?: boolean | null
  ma_align?: boolean | null
  volume_triggered?: boolean | null
}

/**
 * recommendation_history를 페이지 단위로 끝까지 읽는다.
 *
 * 특성 컬럼(score 등)은 supabase/recommendation_history_features.sql을 실행해야 생긴다.
 * 아직 실행 전이면 select 자체가 실패하는데, 그때 예외를 올리면 성적 섹션이 통째로
 * 사라진다 — 그래서 기본 컬럼만으로 한 번 더 시도한다(특성별 표만 비고 나머지는 보인다).
 */
async function fetchPatternRecRows(cutoffStr: string, today: string): Promise<PatternRecRow[]> {
  const supabase = createServerSupabaseClient()

  const page = async (columns: string, from: number) =>
    supabase
      .from('recommendation_history')
      .select(columns)
      .lt('recommended_date', today)
      .gte('recommended_date', cutoffStr)
      // 같은 종목의 첫 추천만 세려면 날짜 오름차순이어야 한다. ticker까지 정렬해야
      // 1000행 경계에 걸린 행이 페이지마다 순서가 달라 빠지거나 두 번 들어오지 않는다.
      .order('recommended_date', { ascending: true })
      .order('ticker', { ascending: true })
      .range(from, from + PATTERN_REC_PAGE - 1)

  let columns = `${PATTERN_REC_BASE_COLUMNS}, ${PATTERN_REC_FEATURE_COLUMNS}`
  const probe = await page(columns, 0)
  if (probe.error) {
    console.warn(
      `[patternScorecard] 특성 컬럼 조회 실패(${probe.error.message}) → 기본 컬럼만 사용. ` +
        'supabase/recommendation_history_features.sql을 실행하면 특성별 표가 채워진다.',
    )
    columns = PATTERN_REC_BASE_COLUMNS
  }

  const rows: PatternRecRow[] = []
  for (let from = 0; ; from += PATTERN_REC_PAGE) {
    const { data, error } = from === 0 && !probe.error ? probe : await page(columns, from)
    if (error) throw new Error(error.message)
    const batch = (data ?? []) as unknown as PatternRecRow[]
    rows.push(...batch)
    if (batch.length < PATTERN_REC_PAGE) break
  }
  return rows
}

/**
 * 저점 매집 후보 추천을 앞으로 걸어 결과를 낸다 (app/history의 전용 섹션).
 *
 * 기본 창이 270일인 이유: 판정에 PATTERN_HOLD_BARS(60거래일 ≈ 3개월)가 걸리므로
 * 그보다 짧으면 판정 완료 표본이 거의 안 남는다. 270일이면 앞쪽 약 6개월이 판정
 * 완료로 쌓이고 최근 3개월은 pending으로 분리된다.
 *
 * 이 탭은 미국 종목 전용이다(pattern_discovery가 US 유니버스만 스캔한다).
 */
export async function getPatternRecommendations(days = 270): Promise<ResolvedPatternRec[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)

  const today = new Date().toISOString().slice(0, 10)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const rows = await fetchPatternRecRows(cutoffStr, today)
  if (rows.length === 0) return []

  // 같은 종목이 바닥 구간 내내 며칠씩 반복 추천된다. 그걸 다 세면 한 종목의 결과가
  // 표본을 장악하므로, 창 안의 첫 추천 하나만 트레이드로 센다(눌림목 성적과 같은 규칙).
  // 위에서 날짜 오름차순으로 받았으므로 먼저 들어온 쪽이 첫 추천이다.
  const firstByTicker = new Map<string, PatternRecRow>()
  for (const row of rows) {
    // 진입가가 없으면 수익률을 못 낸다. 0으로 세면 성적이 왜곡되므로 표본에서 뺀다.
    if (!row.entry_price || row.entry_price <= 0) continue
    if (!firstByTicker.has(row.ticker)) firstByTicker.set(row.ticker, row)
  }
  const picks = [...firstByTicker.values()]
  if (picks.length === 0) return []

  const tickers = picks.map((p) => p.ticker)

  // 종목마다 필요한 건 "자기 추천일 이후 60거래일"뿐인데, 가장 오래된 추천일 하나로
  // 전부 받으면 9개월치를 통째로 끌어온다(종목 수 × 창 길이가 그대로 행 수다).
  // 그래서 추천 월별로 묶어 그 구간만 받는다 — 한 종목은 첫 추천 하나만 남기므로
  // 정확히 한 묶음에만 들어간다.
  const byMonth = new Map<string, PatternRecRow[]>()
  for (const pick of picks) {
    const month = pick.recommended_date.slice(0, 7)
    const bucket = byMonth.get(month)
    if (bucket) bucket.push(pick)
    else byMonth.set(month, [pick])
  }

  const [priceGroups, nameKrMap] = await Promise.all([
    Promise.all(
      [...byMonth.values()].map((group) => {
        const from = group.reduce((min, p) => (p.recommended_date < min ? p.recommended_date : min), group[0].recommended_date)
        const until = new Date(from)
        // 한 묶음의 마지막 추천은 월초보다 최대 31일 늦고, 거기서 60거래일(주말 포함
        // 약 90일)이 더 필요하다. 여유가 모자라 봉이 잘리면 그 추천이 조용히
        // settled=false가 되어 표본에서 빠지므로 넉넉하게 잡는다.
        until.setDate(until.getDate() + PATTERN_PRICE_WINDOW_DAYS)
        return fetchPriceRowsPaged<PriceBar & { ticker: string }>(
          // 손절·목표를 계산하지 않으므로 추천일 앞쪽 봉은 필요 없다 — 추천일부터 받는다.
          'US', group.map((p) => p.ticker), 'ticker, date, high, low, close',
          from, until.toISOString().slice(0, 10),
        )
      }),
    ),
    getUniverseNameMap('US', tickers),
  ])

  const priceMap: Record<string, PriceBar[]> = {}
  for (const row of priceGroups.flat()) {
    priceMap[row.ticker] ??= []
    priceMap[row.ticker].push({ date: row.date, high: row.high, low: row.low, close: row.close })
  }

  return picks.map((pick) => {
    const features: PatternFeatures = {
      score: pick.score ?? null,
      drawdownPct: pick.drawdown_pct ?? null,
      daysSinceLow: pick.days_since_low ?? null,
      volRatio: pick.vol_ratio ?? null,
      vcp: pick.vcp ?? null,
      maAlign: pick.ma_align ?? null,
      volumeTriggered: pick.volume_triggered ?? null,
    }

    return resolvePatternRec({
      date: pick.recommended_date,
      ticker: pick.ticker,
      name: pick.name,
      nameKr: nameKrMap[pick.ticker],
      sector: pick.sector,
      rank: pick.rank,
      entry: pick.entry_price as number,
      futureBars: (priceMap[pick.ticker] ?? []).filter((b) => b.date > pick.recommended_date),
      features,
    })
  })
}
