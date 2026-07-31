import { cacheLife, cacheTag } from 'next/cache'

// 파이프라인이 매일 아침 DB를 갱신한 직후 /api/revalidate가 이 태그를 일괄 무효화해,
// 모든 페이지·섹션이 같은 시점의 데이터로 함께 갱신된다. cacheLife는 웹훅 실패 시 안전망.
export const SCREENER_CACHE_TAG = 'screener-data'
import { createServerSupabaseClient } from './supabase'
import { computeStopTarget, filterBarsAsOf, isBelowTrend, type PriceBar } from './risk'
import type { DailyBar } from './opportunityScore'
import type { DayReturn, ExitCheckResult, ExitStatus, LeadingSectorRow, Market, MarketCapMap, MarketRegimeRow, PriceHistoryRow, ScreenedStockPerf, ScreenedStockRow, ScreenedStockWithRisk, TrackRecord, UniverseStockRow, WatchlistStatusRow, FundamentalsRow } from './types'

// 감시 종목(보유 종목) 상태. 테이블 미생성(CREATE TABLE 미실행) 상태에서도
// 홈 화면이 깨지지 않도록 실패 시 빈 배열을 반환한다.
export async function getWatchlistStatus(): Promise<WatchlistStatusRow[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('watchlist_status')
    .select('*')
    .order('ticker', { ascending: true })
  if (error) return []
  return (data ?? []) as WatchlistStatusRow[]
}

// 미국 시총·주가의 원화 환산용 환율. 실패 시 대략적인 고정값으로 폴백.
export async function fetchUsdKrwRate(): Promise<number> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=KRW')
    const json = await res.json()
    return json.rates.KRW as number
  } catch {
    return 1380
  }
}

export async function getLatestRegime(market: Market): Promise<MarketRegimeRow | null> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('market_regime')
    .select('date, market, regime')
    .eq('market', market)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data as MarketRegimeRow | null
}

export async function getLeadingSectors(market: Market, date: string): Promise<LeadingSectorRow[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('leading_sectors')
    .select('date, market, sector, rank')
    .eq('market', market)
    .eq('date', date)
    .order('rank', { ascending: true })

  if (error) throw new Error(error.message)
  return (data ?? []) as LeadingSectorRow[]
}

export async function getScreenedStocks(market: Market, date: string): Promise<ScreenedStockRow[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('screened_stocks')
    .select('date, market, ticker, name, sector, close, market_cap, rsi, passed, failed_criteria')
    .eq('market', market)
    .eq('date', date)

  if (error) throw new Error(error.message)
  // 전 조건 통과 종목 먼저, 근접 후보는 미달 조건 적은 순
  const rows = (data ?? []) as ScreenedStockRow[]
  return rows.sort(
    (a, b) =>
      Number(b.passed) - Number(a.passed) ||
      a.failed_criteria.length - b.failed_criteria.length,
  )
}

// PostgREST caps a single response at max_rows=1000. A flat `.in(tickers)` query over
// ~100 bars/ticker silently truncates once ~10+ tickers are requested, and because the
// rows come back date-ascending the truncation drops each ticker's most RECENT bars —
// leaving some tickers under the 65-bar minimum that computeStopTarget/isUptrend needs,
// which then reports "손익비 —" for stocks that actually qualify. So we batch the ticker
// list and page each batch to completion, exactly like getDailyBars.
const PRICE_HISTORY_BATCH = 15
const PRICE_HISTORY_PAGE = 1000

// stock_price_history를 여러 티커에 대해 읽는 모든 곳이 써야 하는 헬퍼.
// 위 max_rows=1000 절단은 조용히 일어나 데이터가 "일부만" 돌아오므로,
// 개별 호출부가 페이지네이션을 빠뜨리면 알아채기 어려운 오작동이 된다.
async function fetchPriceRowsPaged<T>(
  market: Market,
  tickers: string[],
  columns: string,
  cutoffStr: string,
): Promise<T[]> {
  if (tickers.length === 0) return []
  const supabase = createServerSupabaseClient()
  const batches: string[][] = []
  for (let i = 0; i < tickers.length; i += PRICE_HISTORY_BATCH) {
    batches.push(tickers.slice(i, i + PRICE_HISTORY_BATCH))
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const rows: T[] = []
      for (let from = 0; ; from += PRICE_HISTORY_PAGE) {
        const { data, error } = await supabase
          .from('stock_price_history')
          .select(columns)
          .eq('market', market)
          .in('ticker', batch)
          .gte('date', cutoffStr)
          .order('ticker', { ascending: true })
          .order('date', { ascending: true })
          .range(from, from + PRICE_HISTORY_PAGE - 1)
        if (error) throw new Error(error.message)
        rows.push(...((data ?? []) as T[]))
        if (!data || data.length < PRICE_HISTORY_PAGE) break
      }
      return rows
    }),
  )
  return results.flat()
}

export async function getPriceHistoryByTicker(
  market: Market,
  tickers: string[],
  days = 150,
): Promise<Record<string, PriceHistoryRow[]>> {
  // 홈 화면에서 가장 무거운 쿼리(전 종목 × ~150일 봉)인데 데이터는 하루 한 번만
  // 바뀐다. 다른 쿼리들과 같은 태그로 캐시해 매 방문마다 Supabase 왕복을 없앤다.
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  if (tickers.length === 0) return {}

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const supabase = createServerSupabaseClient()

  const batches: string[][] = []
  for (let i = 0; i < tickers.length; i += PRICE_HISTORY_BATCH) {
    batches.push(tickers.slice(i, i + PRICE_HISTORY_BATCH))
  }

  const fetchBatch = async (batch: string[]): Promise<PriceHistoryRow[]> => {
    const rows: PriceHistoryRow[] = []
    for (let from = 0; ; from += PRICE_HISTORY_PAGE) {
      const { data, error } = await supabase
        .from('stock_price_history')
        .select('ticker, market, date, open, high, low, close, volume')
        .eq('market', market)
        .in('ticker', batch)
        .gte('date', cutoffStr)
        .order('ticker', { ascending: true })
        .order('date', { ascending: true })
        .range(from, from + PRICE_HISTORY_PAGE - 1)
      if (error) throw new Error(error.message)
      rows.push(...((data ?? []) as PriceHistoryRow[]))
      if (!data || data.length < PRICE_HISTORY_PAGE) break
    }
    return rows
  }

  const batchResults = await Promise.all(batches.map(fetchBatch))

  const grouped: Record<string, PriceHistoryRow[]> = {}
  for (const row of batchResults.flat()) {
    grouped[row.ticker] ??= []
    grouped[row.ticker].push(row)
  }
  return grouped
}

export async function getUniverseStocks(
  market: Market,
  memberships?: string[],
): Promise<UniverseStockRow[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()
  const PAGE_SIZE = 1000
  const rows: UniverseStockRow[] = []

  for (let page = 0; ; page++) {
    const from = page * PAGE_SIZE
    const to = from + PAGE_SIZE - 1
    const query = memberships?.length
      ? supabase
          .from('stock_universe')
          .select('ticker, market, name, name_kr, sector, index_membership, updated_at')
          .eq('market', market)
          .in('index_membership', memberships)
      : supabase
          .from('stock_universe')
          .select('ticker, market, name, name_kr, sector, index_membership, updated_at')
          .eq('market', market)

    const { data, error } = await query.range(from, to)
    if (error) return []

    rows.push(...((data ?? []) as UniverseStockRow[]))
    if (!data || data.length < PAGE_SIZE) break
  }

  return rows
}

export async function getUniverseNameMap(
  market: Market,
  tickers: string[],
): Promise<Record<string, string>> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  if (tickers.length === 0) return {}
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('stock_universe')
    .select('ticker, name_kr')
    .eq('market', market)
    .in('ticker', tickers)
  if (error) return {}
  const map: Record<string, string> = {}
  for (const row of (data ?? []) as { ticker: string; name_kr: string | null }[]) {
    if (row.name_kr) map[row.ticker] = row.name_kr
  }
  return map
}

// stock_universe에서 시가총액만 조회. market_cap 컬럼이 아직 없는 배포(ALTER 미실행)나
// 파이프라인 미갱신 상태에서도 화면이 깨지지 않도록, 실패하면 빈 맵을 반환한다.
export async function getUniverseMarketCaps(
  market: Market,
  tickers: string[],
): Promise<MarketCapMap> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  if (tickers.length === 0) return {}
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('stock_universe')
    .select('ticker, market_cap')
    .eq('market', market)
    .in('ticker', tickers)
  if (error) return {}
  const map: MarketCapMap = {}
  for (const row of (data ?? []) as { ticker: string; market_cap: number | null }[]) {
    if (row.market_cap != null && row.market_cap > 0) map[row.ticker] = row.market_cap
  }
  return map
}

// 장기(10년) 월봉. stock_long_monthly는 과거 확정 구간이라 갱신이 거의 없고,
// 최근 3년은 mv_monthly_ohlcv(getMonthlyPriceHistory)가 매일 갱신한다. 둘을
// 합쳐야 "진짜 최고점"과 10년 차트를 모두 얻는다. 테이블 미생성 시 빈 맵.
// PostgREST가 응답을 max_rows=1000으로 자른다. 10년 월봉은 종목당 120행이라
// 배치 하나가 이 한도를 훌쩍 넘고, month_start 오름차순이라 잘리면 각 종목의
// 최근 구간이 통째로 사라진다(실제로 2018-01에서 끊기고 최근 3년으로 건너뛰는
// 차트가 됐다). getPriceHistoryByTicker와 동일하게 배치를 끝까지 페이지네이션한다.
const LONG_MONTHLY_BATCH = 60
const LONG_MONTHLY_PAGE = 1000

export async function getLongMonthlyHistory(
  market: Market,
  tickers: string[],
): Promise<Record<string, PriceHistoryRow[]>> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  if (tickers.length === 0) return {}
  const supabase = createServerSupabaseClient()

  const batches: string[][] = []
  for (let i = 0; i < tickers.length; i += LONG_MONTHLY_BATCH) {
    batches.push(tickers.slice(i, i + LONG_MONTHLY_BATCH))
  }

  type LongRow = { ticker: string; month_start: string; open: number; high: number; low: number; close: number; volume: number }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const rows: LongRow[] = []
      for (let from = 0; ; from += LONG_MONTHLY_PAGE) {
        const { data, error } = await supabase
          .from('stock_long_monthly')
          .select('ticker, month_start, open, high, low, close, volume')
          .eq('market', market)
          .in('ticker', batch)
          .order('ticker', { ascending: true })
          .order('month_start', { ascending: true })
          .range(from, from + LONG_MONTHLY_PAGE - 1)
        if (error) return rows
        rows.push(...((data ?? []) as LongRow[]))
        if (!data || data.length < LONG_MONTHLY_PAGE) break
      }
      return rows
    }),
  )

  const grouped: Record<string, PriceHistoryRow[]> = {}
  for (const row of results.flat()) {
    grouped[row.ticker] ??= []
    grouped[row.ticker].push({
      ticker: row.ticker,
      market,
      date: row.month_start,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    })
  }
  return grouped
}

// 실적 요약. 테이블 미생성·미수집이면 빈 맵을 돌려주고 화면은 해당 섹션을 숨긴다.
export async function getFundamentals(
  market: Market,
  tickers: string[],
): Promise<Record<string, FundamentalsRow>> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  if (tickers.length === 0) return {}
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('stock_fundamentals')
    .select('*')
    .eq('market', market)
    .in('ticker', tickers)
  if (error) return {}
  const map: Record<string, FundamentalsRow> = {}
  for (const row of (data ?? []) as FundamentalsRow[]) map[row.ticker] = row
  return map
}

type DrawdownSummary = {
  ticker: string
  high3y: number
  current_close: number
  row_count: number
}

// Monthly OHLCV via SQL aggregation. Batched to stay under PostgREST max_rows=1000
// (36 bars × 25 tickers = 900 rows per batch; batches run in parallel).
const MONTHLY_BATCH_SIZE = 25

export async function getMonthlyPriceHistory(
  market: Market,
  tickers: string[],
  days = 1095,
): Promise<Record<string, PriceHistoryRow[]>> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  if (tickers.length === 0) return {}
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  const supabase = createServerSupabaseClient()

  const batches: string[][] = []
  for (let i = 0; i < tickers.length; i += MONTHLY_BATCH_SIZE) {
    batches.push(tickers.slice(i, i + MONTHLY_BATCH_SIZE))
  }

  const batchResults = await Promise.all(
    batches.map(async (batch) => {
      const { data, error } = await supabase.rpc('get_monthly_ohlcv', {
        p_market: market,
        p_tickers: batch,
        p_cutoff: cutoffStr,
      })
      if (error) throw new Error(error.message)
      return (data ?? []) as PriceHistoryRow[]
    }),
  )

  const grouped: Record<string, PriceHistoryRow[]> = {}
  for (const rows of batchResults) {
    for (const row of rows) {
      grouped[row.ticker] ??= []
      grouped[row.ticker].push(row)
    }
  }
  return grouped
}

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

// Re-evaluates past recommendations that may still be held: walks forward through ALL
// bars since entry (not a fixed day1-3 window) to find the first stop/target breach, then
// checks CURRENT regime/leading-sector/trend state (not the state at entry time) so a
// still-open position gets flagged the moment the setup it was bought on breaks down.
export async function getExitSignals(market: Market, days = 30): Promise<ExitCheckResult[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)

  const supabase = createServerSupabaseClient()
  const today = new Date().toISOString().slice(0, 10)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  // passed=true만: 근접 후보(참고용)는 보유 종목 점검 대상이 아니다
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

  const latestRegime = await getLatestRegime(market)
  const leadingSectors = latestRegime ? await getLeadingSectors(market, latestRegime.date) : []
  const leadingSectorSet = new Set(leadingSectors.map((s) => s.sector))

  return (recs as { date: string; market: string; ticker: string; name: string; sector: string; close: number }[]).map(
    (rec) => {
      const allBars = priceMap[rec.ticker] ?? []
      const preBars = allBars.filter((p) => p.date <= rec.date)
      const future = allBars.filter((p) => p.date > rec.date)

      const { stop, target, riskReward } = computeStopTarget(preBars, rec.close)

      let status: ExitStatus = 'open'
      let exitDate: string | null = null
      for (const bar of future) {
        if (stop !== null && bar.low <= stop) {
          status = 'stopped_out'
          exitDate = bar.date
          break
        }
        if (target !== null && bar.high >= target) {
          status = 'target_hit'
          exitDate = bar.date
          break
        }
      }

      const latestBar = allBars.at(-1) ?? null
      const currentPrice = latestBar?.close ?? rec.close
      const currentReturnPct = ((currentPrice - rec.close) / rec.close) * 100

      const exitReasons: string[] = []
      if (status === 'open') {
        if (latestRegime?.regime === 'bear') exitReasons.push('시장이 하락장으로 전환되었습니다')
        if (leadingSectorSet.size > 0 && !leadingSectorSet.has(rec.sector)) {
          exitReasons.push('주도 섹터에서 이탈했습니다')
        }
        if (isBelowTrend(allBars)) exitReasons.push('60일 이동평균선을 하회합니다')
      }

      const recommendation: 'sell' | 'hold' = status !== 'open' || exitReasons.length > 0 ? 'sell' : 'hold'

      return {
        date: rec.date,
        market: rec.market as Market,
        ticker: rec.ticker,
        name: rec.name,
        name_kr: nameKrMap[rec.ticker],
        sector: rec.sector,
        entryPrice: rec.close,
        currentPrice,
        currentReturnPct,
        stop,
        target,
        riskReward,
        status,
        exitDate,
        exitReasons,
        recommendation,
      }
    },
  )
}

// Aggregate 90-day track record: walk each past pullback recommendation forward to its
// stop/target resolution (same logic as getExitSignals), dedupe to the first day each ticker
// was recommended within the window, then summarize hit/stop/open rates and P&L stats.
export async function getScreenerTrackRecord(market: Market, days = 90): Promise<TrackRecord> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)

  const supabase = createServerSupabaseClient()
  const today = new Date().toISOString().slice(0, 10)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  // passed=true만: 성적표는 실제 추천(전 조건 통과)의 기록이어야 한다
  const { data: recs, error: recsError } = await supabase
    .from('screened_stocks')
    .select('date, ticker, close')
    .eq('market', market)
    .eq('passed', true)
    .lt('date', today)
    .gte('date', cutoffStr)
    .order('date', { ascending: false })

  if (recsError) throw new Error(recsError.message)

  const empty: TrackRecord = {
    market,
    totalTrades: 0,
    targetHitRate: 0,
    stoppedOutRate: 0,
    openRate: 0,
    avgReturnPct: 0,
    avgHoldingDays: 0,
    avgR: 0,
  }
  if (!recs?.length) return empty

  // Dedupe to the first (earliest) recommendation per ticker within the window. recs come
  // in date-descending order, so the last match for each ticker is its earliest date.
  const firstByTicker = new Map<string, { date: string; ticker: string; close: number }>()
  for (const rec of recs as { date: string; ticker: string; close: number }[]) {
    firstByTicker.set(rec.ticker, rec)
  }
  const trades = [...firstByTicker.values()]

  const tickers = [...firstByTicker.keys()]
  const oldestDate = trades.reduce((min, t) => (t.date < min ? t.date : min), trades[0].date)

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

  let targetHits = 0
  let stoppedOut = 0
  let open = 0
  const closedReturns: number[] = []
  const closedHoldingDays: number[] = []
  const closedR: number[] = []

  for (const trade of trades) {
    const allBars = priceMap[trade.ticker] ?? []
    const preBars = allBars.filter((p) => p.date <= trade.date)
    const future = allBars.filter((p) => p.date > trade.date)

    const { stop, target } = computeStopTarget(preBars, trade.close)
    // Skip recommendations whose stop/target can't be computed: an unresolvable trade
    // would distort the rates and R stats.
    if (stop === null || target === null) continue

    let status: ExitStatus = 'open'
    let holdingDays = 0
    for (let i = 0; i < future.length; i++) {
      const bar = future[i]
      // Same-bar tie: stop takes priority (conservative).
      if (bar.low <= stop) {
        status = 'stopped_out'
        holdingDays = i + 1
        break
      }
      if (bar.high >= target) {
        status = 'target_hit'
        holdingDays = i + 1
        break
      }
    }

    if (status === 'open') {
      open++
      continue
    }

    const exitPrice = status === 'target_hit' ? target : stop
    const returnPct = ((exitPrice - trade.close) / trade.close) * 100
    const risk = trade.close - stop
    closedReturns.push(returnPct)
    closedHoldingDays.push(holdingDays)
    if (risk > 0) closedR.push((exitPrice - trade.close) / risk)

    if (status === 'target_hit') targetHits++
    else stoppedOut++
  }

  const total = targetHits + stoppedOut + open
  if (total === 0) return empty

  const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

  return {
    market,
    totalTrades: total,
    targetHitRate: targetHits / total,
    stoppedOutRate: stoppedOut / total,
    openRate: open / total,
    avgReturnPct: mean(closedReturns),
    avgHoldingDays: mean(closedHoldingDays),
    avgR: mean(closedR),
  }
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

// Computes 3-year high + current close in the DB (bypasses PostgREST max_rows=1000).
// The aggregation is per-ticker independent, so we split the universe into batches and
// run them in parallel — each batch scans far fewer price rows and stays well under the
// statement timeout that a single 1000-ticker call was hitting.
const OPP_DRAWDOWN_BATCH = 250

export async function getOpportunityDrawdowns(
  market: Market,
  tickers: string[],
): Promise<DrawdownSummary[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  if (tickers.length === 0) return []
  const cutoff = new Date()
  cutoff.setFullYear(cutoff.getFullYear() - 3)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  const supabase = createServerSupabaseClient()

  const batches: string[][] = []
  for (let i = 0; i < tickers.length; i += OPP_DRAWDOWN_BATCH) {
    batches.push(tickers.slice(i, i + OPP_DRAWDOWN_BATCH))
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const { data, error } = await supabase.rpc('get_opp_drawdowns', {
        p_market: market,
        p_tickers: batch,
        p_cutoff: cutoffStr,
      })
      if (error) throw new Error(error.message)
      return (data ?? []) as DrawdownSummary[]
    }),
  )

  return results.flat()
}

// Fetches ~1 year of daily OHLCV for the drawdown-passing tickers only.
// PostgREST caps responses at max_rows=1000, so each batch is kept small enough
// (15 tickers × ~260 bars ≈ 3,900 rows) to page through with .range() in a few
// round trips. Batches run in bounded waves: KR alone is ~43 batches and both
// markets load concurrently, so an unbounded Promise.all piles ~56 heap-fetch
// queries onto the DB at once and trips statement_timeout on a cold cache.
const DAILY_BARS_BATCH = 15
const DAILY_BARS_PAGE = 1000
// 저점 높이기가 240거래일(≈1년)을 두 구간으로 비교하므로 여유를 둔 창.
const DAILY_BARS_CALENDAR_DAYS = 500
const DAILY_BARS_CONCURRENCY = 6

export async function getDailyBars(
  market: Market,
  tickers: string[],
): Promise<Record<string, DailyBar[]>> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  if (tickers.length === 0) return {}
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - DAILY_BARS_CALENDAR_DAYS)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  const supabase = createServerSupabaseClient()

  const batches: string[][] = []
  for (let i = 0; i < tickers.length; i += DAILY_BARS_BATCH) {
    batches.push(tickers.slice(i, i + DAILY_BARS_BATCH))
  }

  type DailyBarRow = DailyBar & { ticker: string }

  const fetchBatch = async (batch: string[]) => {
    const rows: DailyBarRow[] = []
    for (let from = 0; ; from += DAILY_BARS_PAGE) {
      const { data, error } = await supabase
        .from('stock_price_history')
        .select('ticker, date, close, high, low, volume')
        .eq('market', market)
        .in('ticker', batch)
        .gte('date', cutoffStr)
        .order('ticker', { ascending: true })
        .order('date', { ascending: true })
        .range(from, from + DAILY_BARS_PAGE - 1)
      if (error) throw new Error(error.message)
      rows.push(...((data ?? []) as DailyBarRow[]))
      if (!data || data.length < DAILY_BARS_PAGE) break
    }
    return rows
  }

  const results: DailyBarRow[][] = []
  for (let i = 0; i < batches.length; i += DAILY_BARS_CONCURRENCY) {
    results.push(
      ...(await Promise.all(batches.slice(i, i + DAILY_BARS_CONCURRENCY).map(fetchBatch))),
    )
  }

  const byTicker: Record<string, DailyBar[]> = {}
  for (const { ticker, ...barFields } of results.flat()) {
    ;(byTicker[ticker] ??= []).push(barFields)
  }
  return byTicker
}
