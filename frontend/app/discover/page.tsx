import { Suspense } from 'react'
import { connection } from 'next/server'
import { getUniverseStocks, getOpportunityDrawdowns, getMonthlyPriceHistory, getDailyBars } from '@/lib/queries'
import { scoreOpportunity } from '@/lib/opportunityScore'
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

  const history = await getMonthlyPriceHistory(market, scored.map(({ summary }) => summary.ticker))
  const metaMap = new Map(universe.map((u) => [u.ticker, u]))

  return scored.map(({ summary: s, signals, asOfDate }) => {
    const meta = metaMap.get(s.ticker)
    const drawdown = ((s.high3y - s.current_close) / s.high3y) * 100
    return {
      ticker: s.ticker,
      name: meta?.name ?? s.ticker,
      name_kr: meta?.name_kr,
      sector: meta?.sector ?? null,
      index_membership: meta?.index_membership ?? null,
      market,
      currentClose: history[s.ticker]?.at(-1)?.close ?? s.current_close,
      high3y: s.high3y,
      drawdown,
      history: history[s.ticker] ?? [],
      asOfDate,
      ...signals,
    }
  })
}

async function loadOpportunities(): Promise<OpportunityStockRow[]> {
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

  try {
    opportunities = await loadOpportunities()
  } catch (cause) {
    opportunityError = cause instanceof Error ? cause.message : '데이터를 불러오지 못했습니다.'
  }

  return (
    <DiscoverTabs
      opportunities={opportunities}
      opportunityError={opportunityError}
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
