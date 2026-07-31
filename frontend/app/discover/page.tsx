import { Suspense } from 'react'
import { connection } from 'next/server'
import { cacheLife, cacheTag } from 'next/cache'
import { SCREENER_CACHE_TAG, fetchUsdKrwRate, getUniverseStocks, getOpportunityDrawdowns, getMonthlyPriceHistory, getDailyBars, getUniverseMarketCaps, getLongMonthlyHistory, getFundamentals } from '@/lib/queries'
import { scoreOpportunity } from '@/lib/opportunityScore'
import { buildLongTermContext } from '@/lib/longTermContext'
import type { Market, OpportunityStockRow } from '@/lib/types'
import { DiscoverTabs } from './DiscoverTabs'

const MIN_DRAWDOWN = 20
const MAX_DRAWDOWN = 60

async function computeOpportunities(
  universe: { ticker: string; name: string; name_kr?: string; sector: string | null; index_membership: string | null }[],
  market: Market,
): Promise<OpportunityStockRow[]> {
  if (universe.length === 0) return []

  const tickers = universe.map((u) => u.ticker)
  const summaries = await getOpportunityDrawdowns(market, tickers)

  const passing = summaries.filter((s) => {
    if (s.high3y <= 0) return false
    const dd = ((s.high3y - s.current_close) / s.high3y) * 100
    return dd >= MIN_DRAWDOWN && dd <= MAX_DRAWDOWN
  })

  if (passing.length === 0) return []

  // 하드 필터(신저가 갱신 중·박스폭 초과)를 통과한 종목만 매수 매력도와 함께 남긴다
  const dailyBars = await getDailyBars(market, passing.map((s) => s.ticker))
  const scored = passing.flatMap((s) => {
    const bars = dailyBars[s.ticker] ?? []
    const signals = scoreOpportunity(bars)
    return signals ? [{ summary: s, signals, asOfDate: bars.at(-1)?.date ?? null }] : []
  })

  if (scored.length === 0) return []

  const finalTickers = scored.map(({ summary }) => summary.ticker)
  const [history, marketCaps, longMonthly, fundamentals] = await Promise.all([
    getMonthlyPriceHistory(market, finalTickers),
    getUniverseMarketCaps(market, finalTickers),
    getLongMonthlyHistory(market, finalTickers),
    getFundamentals(market, finalTickers),
  ])
  const metaMap = new Map(universe.map((u) => [u.ticker, u]))

  return scored.map(({ summary: s, signals, asOfDate }) => {
    const meta = metaMap.get(s.ticker)
    const drawdown = ((s.high3y - s.current_close) / s.high3y) * 100
    const recentMonthly = history[s.ticker] ?? []
    const currentClose = recentMonthly.at(-1)?.close ?? s.current_close
    // 3년 창 밖 고점까지 반영한 장기 맥락. 차트도 병합 시리즈를 쓴다.
    const longTerm = buildLongTermContext(
      longMonthly[s.ticker] ?? [],
      recentMonthly,
      currentClose,
      s.high3y,
    )
    return {
      ticker: s.ticker,
      name: meta?.name ?? s.ticker,
      name_kr: meta?.name_kr,
      sector: meta?.sector ?? null,
      index_membership: meta?.index_membership ?? null,
      market,
      currentClose,
      high3y: s.high3y,
      drawdown,
      history: longTerm.monthly.length > 0 ? longTerm.monthly : recentMonthly,
      asOfDate,
      marketCap: marketCaps[s.ticker] ?? null,
      longTermHigh: longTerm.longTermHigh,
      longTermDrawdown: longTerm.longTermDrawdown,
      longTermDeclining: longTerm.longTermDeclining,
      hasLongHistory: longTerm.hasLongHistory,
      fundamentals: fundamentals[s.ticker] ?? null,
      ...signals,
    }
  })
}

// 개별 쿼리(일봉·월봉·조정폭)는 각각 캐시되지만, 그것만으로는 방문마다 수백 종목 ×
// 400일 일봉(수 MB)을 캐시에서 꺼내 scoreOpportunity를 다시 돌려야 해 탭이 느렸다.
// 최종 결과(카드 수십 개)를 통째로 캐시해 그 재계산을 없앤다.
async function loadOpportunities(): Promise<OpportunityStockRow[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const [usUniverse, krUniverse] = await Promise.all([
    getUniverseStocks('US', ['NASDAQ100', 'S&P500']),
    getUniverseStocks('KR', ['KOSPI']),
  ])

  const [usOpps, krOpps] = await Promise.all([
    computeOpportunities(usUniverse, 'US'),
    computeOpportunities(krUniverse, 'KR'),
  ])

  // 매수 매력도 순 정렬, 동점이면 하락률 큰 순
  return [...usOpps, ...krOpps].sort((a, b) => b.score - a.score || b.drawdown - a.drawdown)
}

async function DiscoverContent() {
  await connection()
  let opportunities: OpportunityStockRow[] = []
  let opportunityError: string | null = null

  // 환율과 기회 종목은 서로 무관하므로 함께 기다린다 (순차 대기 제거)
  const [usdKrwRate, opportunityResult] = await Promise.all([
    fetchUsdKrwRate(),
    loadOpportunities().then(
      (rows) => ({ rows, error: null as string | null }),
      (cause: unknown) => ({
        rows: [] as OpportunityStockRow[],
        error: cause instanceof Error ? cause.message : '데이터를 불러오지 못했습니다.',
      }),
    ),
  ])
  opportunities = opportunityResult.rows
  opportunityError = opportunityResult.error

  return (
    <DiscoverTabs
      opportunities={opportunities}
      opportunityError={opportunityError}
      usdKrwRate={usdKrwRate}
    />
  )
}

export default function DiscoverPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Suspense fallback={<p className="py-16 text-center text-muted-foreground">로딩 중...</p>}>
        <DiscoverContent />
      </Suspense>
    </main>
  )
}
