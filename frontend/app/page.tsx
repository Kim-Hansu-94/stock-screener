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

      <section className="rounded-lg border border-gray-200 text-sm">
        <details>
          <summary className="cursor-pointer select-none px-4 py-3 font-medium text-gray-700 hover:bg-gray-50">
            스크리닝 기준
          </summary>
          <div className="space-y-4 px-4 pb-4 pt-2 text-gray-600">
            <div>
              <p className="mb-2 text-xs text-gray-400">아래 조건을 모두 충족한 종목만 표시됩니다.</p>
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="py-1.5 pr-4 text-left font-medium text-gray-500">단계</th>
                    <th className="py-1.5 text-left font-medium text-gray-500">기준</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  <tr>
                    <td className="py-1.5 pr-4 font-medium text-gray-700 whitespace-nowrap">시장 분위기</td>
                    <td className="py-1.5">지수 종가 &gt; 50일선 &gt; 200일선 (상승장 확인)</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4 font-medium text-gray-700 whitespace-nowrap">주도 섹터</td>
                    <td className="py-1.5">최근 5일 거래대금 + 섹터 평균 상승 기준 상위 3개 섹터에 속한 종목만 통과</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4 font-medium text-gray-700 whitespace-nowrap">시가총액</td>
                    <td className="py-1.5">한국 3,000억원 이상 / 미국 2억달러 이상</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4 font-medium text-gray-700 whitespace-nowrap">장기 추세</td>
                    <td className="py-1.5">60일 이동평균선 우상향 + 현재가 &gt; 60일선</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4 font-medium text-gray-700 whitespace-nowrap">단기 눌림</td>
                    <td className="py-1.5">20일선 ≤ 현재가 ≤ 10일선 (10~20일선 사이 눌림 구간)</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4 font-medium text-gray-700 whitespace-nowrap">RSI</td>
                    <td className="py-1.5">40 ~ 60 구간 (과열 아님, 과매도 아님)</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-4 font-medium text-gray-700 whitespace-nowrap">거래량</td>
                    <td className="py-1.5">최근 5일 평균 거래량 &lt; 직전 20일 평균 거래량 (매도 압력 약화)</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-gray-400">파이프라인은 매일 오전 8:30 (KST) 전날 데이터를 기준으로 실행됩니다.</p>
          </div>
        </details>
      </section>
    </main>
  )
}
