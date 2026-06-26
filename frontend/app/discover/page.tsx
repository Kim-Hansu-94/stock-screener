import { getUniverseStocks, getAllUniversePriceHistory } from '@/lib/queries'
import type { Market, OpportunityStockRow } from '@/lib/types'
import { DiscoverTabs } from './DiscoverTabs'

const MIN_DRAWDOWN = 20
const MAX_DRAWDOWN = 60

async function computeOpportunities(
  universe: { ticker: string; name: string; sector: string | null; index_membership: string | null }[],
  market: Market,
): Promise<OpportunityStockRow[]> {
  if (universe.length === 0) return []
  const tickers = universe.map((u) => u.ticker)
  const grouped = await getAllUniversePriceHistory(market, tickers)
  const metaMap = new Map(universe.map((u) => [u.ticker, u]))

  const results: OpportunityStockRow[] = []
  for (const [ticker, rows] of Object.entries(grouped)) {
    if (rows.length < 5) continue
    const closes = rows.map((r) => r.close)
    const high3y = Math.max(...closes)
    const currentClose = closes[closes.length - 1]
    const drawdown = ((high3y - currentClose) / high3y) * 100
    if (drawdown < MIN_DRAWDOWN || drawdown > MAX_DRAWDOWN) continue

    const meta = metaMap.get(ticker)
    results.push({
      ticker,
      name: meta?.name ?? ticker,
      sector: meta?.sector ?? null,
      index_membership: meta?.index_membership ?? null,
      market,
      currentClose,
      high3y,
      drawdown,
      history: rows,
    })
  }
  return results
}

async function loadOpportunities(): Promise<OpportunityStockRow[]> {
  const [usUniverse, krUniverse] = await Promise.all([
    getUniverseStocks('US'),
    getUniverseStocks('KR'),
  ])

  const usFiltered = usUniverse.filter(
    (u) => u.index_membership === 'NASDAQ100' || u.index_membership === 'S&P500',
  )

  const [usResults, krResults] = await Promise.all([
    computeOpportunities(usFiltered, 'US'),
    computeOpportunities(krUniverse, 'KR'),
  ])

  return [...usResults, ...krResults].sort((a, b) => b.drawdown - a.drawdown)
}

export default async function DiscoverPage() {
  let opportunities: OpportunityStockRow[] = []
  let opportunityError: string | null = null
  try {
    opportunities = await loadOpportunities()
  } catch (err) {
    opportunityError = err instanceof Error ? err.message : '데이터를 불러오지 못했습니다.'
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <DiscoverTabs opportunities={opportunities} opportunityError={opportunityError} />
    </main>
  )
}
