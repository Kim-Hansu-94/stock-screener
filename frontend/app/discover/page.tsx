import { getUniverseStocks, getAllUniversePriceHistory } from '@/lib/queries'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { OpportunityStockRow } from '@/lib/types'
import { SimilaritySearch } from './SimilaritySearch'

const MIN_DRAWDOWN = 20
const MAX_DRAWDOWN = 60

async function loadOpportunities(): Promise<OpportunityStockRow[]> {
  const universe = await getUniverseStocks('US')
  const nasdaq100 = universe.filter((u) => u.index_membership === 'NASDAQ100')
  if (nasdaq100.length === 0) return []

  const tickers = nasdaq100.map((u) => u.ticker)
  const grouped = await getAllUniversePriceHistory('US', tickers)
  const metaMap = new Map(nasdaq100.map((u) => [u.ticker, u]))

  const results: OpportunityStockRow[] = []
  for (const [ticker, rows] of Object.entries(grouped)) {
    if (rows.length < 5) continue
    const closes = rows.map((r) => r.close)
    const high120d = Math.max(...closes)
    const currentClose = closes[closes.length - 1]
    const drawdown = ((high120d - currentClose) / high120d) * 100
    if (drawdown < MIN_DRAWDOWN || drawdown > MAX_DRAWDOWN) continue

    const meta = metaMap.get(ticker)
    results.push({
      ticker,
      name: meta?.name ?? ticker,
      sector: meta?.sector ?? null,
      index_membership: meta?.index_membership ?? null,
      currentClose,
      high120d,
      drawdown,
      history: rows,
    })
  }
  results.sort((a, b) => b.drawdown - a.drawdown)
  return results
}

export default async function DiscoverPage() {
  let opportunities: OpportunityStockRow[] = []
  let opportunityError: string | null = null
  try {
    opportunities = await loadOpportunities()
  } catch (err) {
    opportunityError =
      err instanceof Error ? err.message : '데이터를 불러오지 못했습니다.'
  }

  return (
    <main className="mx-auto max-w-3xl space-y-10 p-4">
      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold">패턴 유사 종목</h2>
          <p className="text-sm text-gray-500">
            기준 종목의 급등 직전 차트 패턴과 유사한 현재 차트를 가진 종목을 찾습니다.
          </p>
        </div>
        <SimilaritySearch />
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold">미래먹거리 횡보/조정 종목</h2>
          <p className="text-sm text-gray-500">
            NASDAQ 100 종목 중 120일 고점 대비 {MIN_DRAWDOWN}–{MAX_DRAWDOWN}% 조정받은 종목입니다.
          </p>
        </div>

        {opportunityError ? (
          <p className="text-sm text-red-600">{opportunityError}</p>
        ) : opportunities.length === 0 ? (
          <p className="text-sm text-gray-500">
            해당 조건의 종목이 없습니다. 파이프라인 실행 후 데이터가 채워집니다.
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {opportunities.map((stock) => (
              <OpportunityCard key={stock.ticker} stock={stock} />
            ))}
          </div>
        )}
      </section>
    </main>
  )
}

function OpportunityCard({ stock }: { stock: OpportunityStockRow }) {
  const drawdownStr = stock.drawdown.toFixed(1)
  const variant =
    stock.drawdown >= 40 ? 'destructive' : stock.drawdown >= 25 ? 'secondary' : 'outline'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>
            {stock.name} <span className="text-gray-400">({stock.ticker})</span>
          </span>
          <Badge variant={variant}>-{drawdownStr}%</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-2 text-sm text-gray-600">
          <div>
            <dt className="text-gray-400">섹터</dt>
            <dd>{stock.sector ?? '-'}</dd>
          </div>
          <div>
            <dt className="text-gray-400">현재가</dt>
            <dd>${stock.currentClose.toFixed(2)}</dd>
          </div>
          <div>
            <dt className="text-gray-400">120일 고점</dt>
            <dd>${stock.high120d.toFixed(2)}</dd>
          </div>
          <div>
            <dt className="text-gray-400">조정폭</dt>
            <dd>-{drawdownStr}%</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  )
}
