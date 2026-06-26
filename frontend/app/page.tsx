import { cacheLife } from 'next/cache'
import { MarketRegimeBadge } from '@/components/MarketRegimeBadge'
import { LeadingSectors } from '@/components/LeadingSectors'
import { StockCard } from '@/components/StockCard'
import {
  getLatestRegime,
  getLeadingSectors,
  getPriceHistoryByTicker,
  getScreenedStocks,
} from '@/lib/queries'
import type { LeadingSectorRow, Market, PriceHistoryRow, Regime, ScreenedStockRow } from '@/lib/types'

const MARKETS: { market: Market; label: string }[] = [
  { market: 'KR', label: '한국' },
  { market: 'US', label: '미국' },
]

async function fetchUsdKrwRate(): Promise<number> {
  'use cache'
  cacheLife('hours')
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=KRW')
    const json = await res.json()
    return json.rates.KRW as number
  } catch {
    return 1380
  }
}

interface MarketSectionData {
  market: Market
  label: string
  date: string | null
  regime: Regime | null
  sectors: LeadingSectorRow[]
  stocks: ScreenedStockRow[]
  priceHistory: Record<string, PriceHistoryRow[]>
  error: string | null
}

async function loadMarketSection(market: Market, label: string): Promise<MarketSectionData> {
  try {
    const regimeRow = await getLatestRegime(market)
    if (!regimeRow) {
      return { market, label, date: null, regime: null, sectors: [], stocks: [], priceHistory: {}, error: null }
    }

    const [sectors, stocks] = await Promise.all([
      getLeadingSectors(market, regimeRow.date),
      getScreenedStocks(market, regimeRow.date),
    ])
    const priceHistory = await getPriceHistoryByTicker(market, stocks.map((stock) => stock.ticker))

    return { market, label, date: regimeRow.date, regime: regimeRow.regime, sectors, stocks, priceHistory, error: null }
  } catch (cause) {
    return {
      market,
      label,
      date: null,
      regime: null,
      sectors: [],
      stocks: [],
      priceHistory: {},
      error: cause instanceof Error ? cause.message : '데이터를 불러오지 못했습니다.',
    }
  }
}

export default async function HomePage() {
  const [sections, usdKrwRate] = await Promise.all([
    Promise.all(MARKETS.map(({ market, label }) => loadMarketSection(market, label))),
    fetchUsdKrwRate(),
  ])

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-4">
      <h1 className="text-xl font-bold">눌림목 매수 스크리너</h1>

      <div className="flex flex-wrap gap-2">
        {sections.map((section) => (
          <MarketRegimeBadge key={section.market} marketLabel={section.label} regime={section.regime} />
        ))}
      </div>

      {sections.map((section) => (
        <section key={section.market} className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">{section.label} 시장</h2>
            {section.date && (
              <p className="text-xs text-gray-400">데이터 기준: {section.date}</p>
            )}
          </div>

          {section.error && <p className="text-sm text-red-600">{section.error}</p>}

          {!section.error && (
            <>
              <LeadingSectors marketLabel={section.label} sectors={section.sectors} />

              {section.stocks.length === 0 ? (
                <p className="text-sm text-gray-500">오늘은 조건을 만족하는 종목이 없습니다.</p>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {section.stocks.map((stock) => (
                    <StockCard
                      key={stock.ticker}
                      stock={stock}
                      history={section.priceHistory[stock.ticker] ?? []}
                      market={section.market}
                      usdKrwRate={usdKrwRate}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      ))}
    </main>
  )
}
