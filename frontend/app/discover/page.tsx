import { Suspense } from 'react'
import { connection } from 'next/server'
import { getUniverseStocks, getOpportunityDrawdowns, getMonthlyPriceHistory, getPullbackScreenerWithRisk } from '@/lib/queries'
import type { Market, OpportunityStockRow, ScreenedStockWithRisk } from '@/lib/types'
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

  const history = await getMonthlyPriceHistory(market, passing.map((s) => s.ticker))
  const metaMap = new Map(universe.map((u) => [u.ticker, u]))

  return passing.map((s) => {
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
    }
  })
}

async function loadOpportunities(): Promise<OpportunityStockRow[]> {
  const [usUniverse, krUniverse] = await Promise.all([
    getUniverseStocks('US', ['NASDAQ100', 'S&P500']),
    getUniverseStocks('KR'),
  ])

  const [usOpps, krOpps] = await Promise.all([
    computeOpportunities(usUniverse, 'US'),
    computeOpportunities(krUniverse, 'KR'),
  ])

  return [...usOpps, ...krOpps].sort((a, b) => b.drawdown - a.drawdown)
}

async function DiscoverContent() {
  await connection()
  let opportunities: OpportunityStockRow[] = []
  let opportunityError: string | null = null
  let pullbackKR: ScreenedStockWithRisk[] = []
  let pullbackUS: ScreenedStockWithRisk[] = []

  const [oppsResult, krResult, usResult] = await Promise.allSettled([
    loadOpportunities(),
    getPullbackScreenerWithRisk('KR'),
    getPullbackScreenerWithRisk('US'),
  ])

  if (oppsResult.status === 'fulfilled') {
    opportunities = oppsResult.value
  } else {
    opportunityError = oppsResult.reason instanceof Error ? oppsResult.reason.message : '데이터를 불러오지 못했습니다.'
  }
  if (krResult.status === 'fulfilled') pullbackKR = krResult.value
  if (usResult.status === 'fulfilled') pullbackUS = usResult.value

  return (
    <DiscoverTabs
      opportunities={opportunities}
      opportunityError={opportunityError}
      pullbackKR={pullbackKR}
      pullbackUS={pullbackUS}
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
