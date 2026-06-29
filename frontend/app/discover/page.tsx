import { getUniverseStocks, getOpportunityDrawdowns, getPriceHistoryByTicker } from '@/lib/queries'
import type { Market, OpportunityStockRow, PriceHistoryRow } from '@/lib/types'
import { DiscoverTabs } from './DiscoverTabs'

function toMonthlyOHLCV(daily: PriceHistoryRow[]): PriceHistoryRow[] {
  const months: Record<string, PriceHistoryRow[]> = {}
  for (const row of daily) {
    const key = row.date.slice(0, 7)
    ;(months[key] ??= []).push(row)
  }
  return Object.entries(months)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, rows]) => ({
      ticker: rows[0].ticker,
      market: rows[0].market,
      date: rows[rows.length - 1].date,
      open: rows[0].open,
      high: Math.max(...rows.map((r) => r.high)),
      low: Math.min(...rows.map((r) => r.low)),
      close: rows[rows.length - 1].close,
      volume: rows.reduce((sum, r) => sum + r.volume, 0),
    }))
}

const MIN_DRAWDOWN = 20
const MAX_DRAWDOWN = 60

async function computeOpportunities(
  universe: { ticker: string; name: string; sector: string | null; index_membership: string | null }[],
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

  const history = await getPriceHistoryByTicker(
    market,
    passing.map((s) => s.ticker),
    1095,
  )
  const metaMap = new Map(universe.map((u) => [u.ticker, u]))

  return passing.map((s) => {
    const meta = metaMap.get(s.ticker)
    const drawdown = ((s.high3y - s.current_close) / s.high3y) * 100
    return {
      ticker: s.ticker,
      name: meta?.name ?? s.ticker,
      sector: meta?.sector ?? null,
      index_membership: meta?.index_membership ?? null,
      market,
      currentClose: s.current_close,
      high3y: s.high3y,
      drawdown,
      history: toMonthlyOHLCV(history[s.ticker] ?? []),
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
