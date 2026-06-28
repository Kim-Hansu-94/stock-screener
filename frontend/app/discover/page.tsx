import { getUniverseStocks, getAllUniversePriceHistory } from '@/lib/queries'
import type { Market, OpportunityStockRow } from '@/lib/types'
import { DiscoverTabs } from './DiscoverTabs'

const MIN_DRAWDOWN = 20
const MAX_DRAWDOWN = 60


interface DiagInfo {
  usUniverseTotal: number
  usFiltered: number
  usWithHistory: number
  usPassDrawdown: number
  krUniverseTotal: number
  krWithHistory: number
  krPassDrawdown: number
  sampleDrawdowns: { ticker: string; drawdown: number }[]
}

async function loadOpportunities(): Promise<{ opps: OpportunityStockRow[]; diag: DiagInfo }> {
  const [usUniverse, krUniverse] = await Promise.all([
    getUniverseStocks('US'),
    getUniverseStocks('KR'),
  ])

  const usFiltered = usUniverse.filter(
    (u) => u.index_membership === 'NASDAQ100' || u.index_membership === 'S&P500',
  )

  const [usResults, krResults] = await Promise.all([
    computeOpportunitiesWithDiag(usFiltered, 'US'),
    computeOpportunitiesWithDiag(krUniverse, 'KR'),
  ])

  const diag: DiagInfo = {
    usUniverseTotal: usUniverse.length,
    usFiltered: usFiltered.length,
    usWithHistory: usResults.withHistory,
    usPassDrawdown: usResults.opps.length,
    krUniverseTotal: krUniverse.length,
    krWithHistory: krResults.withHistory,
    krPassDrawdown: krResults.opps.length,
    sampleDrawdowns: usResults.sampleDrawdowns,
  }

  const opps = [...usResults.opps, ...krResults.opps].sort((a, b) => b.drawdown - a.drawdown)
  return { opps, diag }
}

async function computeOpportunitiesWithDiag(
  universe: { ticker: string; name: string; sector: string | null; index_membership: string | null }[],
  market: Market,
): Promise<{ opps: OpportunityStockRow[]; withHistory: number; sampleDrawdowns: { ticker: string; drawdown: number }[] }> {
  if (universe.length === 0) return { opps: [], withHistory: 0, sampleDrawdowns: [] }
  const tickers = universe.map((u) => u.ticker)
  const grouped = await getAllUniversePriceHistory(market, tickers)
  const metaMap = new Map(universe.map((u) => [u.ticker, u]))

  const opps: OpportunityStockRow[] = []
  const sampleDrawdowns: { ticker: string; drawdown: number }[] = []
  let withHistory = 0

  for (const [ticker, rows] of Object.entries(grouped)) {
    if (rows.length < 5) continue
    withHistory++
    const closes = rows.map((r) => r.close)
    const high3y = Math.max(...closes)
    const currentClose = closes[closes.length - 1]
    const drawdown = ((high3y - currentClose) / high3y) * 100
    if (sampleDrawdowns.length < 10) sampleDrawdowns.push({ ticker, drawdown: Math.round(drawdown * 10) / 10 })
    if (drawdown < MIN_DRAWDOWN || drawdown > MAX_DRAWDOWN) continue

    const meta = metaMap.get(ticker)
    opps.push({
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
  return { opps, withHistory, sampleDrawdowns }
}

export default async function DiscoverPage() {
  let opportunities: OpportunityStockRow[] = []
  let opportunityError: string | null = null
  let diag: DiagInfo | null = null
  try {
    const result = await loadOpportunities()
    opportunities = result.opps
    diag = result.diag
  } catch (err) {
    opportunityError = err instanceof Error ? err.message : '데이터를 불러오지 못했습니다.'
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      {diag && (
        <details className="mb-6 rounded border border-yellow-300 bg-yellow-50 p-3 text-xs text-gray-700">
          <summary className="cursor-pointer font-semibold text-yellow-800">진단 정보 (임시)</summary>
          <pre className="mt-2 whitespace-pre-wrap">{JSON.stringify(diag, null, 2)}</pre>
        </details>
      )}
      <DiscoverTabs opportunities={opportunities} opportunityError={opportunityError} />
    </main>
  )
}
