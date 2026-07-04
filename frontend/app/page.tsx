import { Suspense } from 'react'
import { connection } from 'next/server'
import { cacheLife } from 'next/cache'
import { LeadingSectors } from '@/components/LeadingSectors'
import { StockCard } from '@/components/StockCard'
import {
  getLatestRegime,
  getLeadingSectors,
  getPriceHistoryByTicker,
  getScreenedStocks,
  getUniverseNameMap,
} from '@/lib/queries'
import type { LeadingSectorRow, Market, PriceHistoryRow, Regime, ScreenedStockRow } from '@/lib/types'
import { computeStopTarget, filterBarsAsOf } from '@/lib/risk'

const MARKETS: { market: Market; label: string; universe: string }[] = [
  { market: 'KR', label: '한국', universe: '코스피 · 코스닥' },
  { market: 'US', label: '미국', universe: 'S&P 500 · NASDAQ 100' },
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

type RiskInfo = { stop: number | null; target: number | null; riskReward: number | null }

interface MarketSectionData {
  market: Market
  label: string
  universe: string
  date: string | null
  regime: Regime | null
  sectors: LeadingSectorRow[]
  stocks: ScreenedStockRow[]
  priceHistory: Record<string, PriceHistoryRow[]>
  riskMap: Record<string, RiskInfo>
  error: string | null
}

async function loadMarketSection(market: Market, label: string, universe: string): Promise<MarketSectionData> {
  try {
    const regimeRow = await getLatestRegime(market)
    if (!regimeRow) {
      return { market, label, universe, date: null, regime: null, sectors: [], stocks: [], priceHistory: {}, riskMap: {}, error: null }
    }

    const [sectors, stocks] = await Promise.all([
      getLeadingSectors(market, regimeRow.date),
      getScreenedStocks(market, regimeRow.date),
    ])
    const priceHistory = await getPriceHistoryByTicker(market, stocks.map((stock) => stock.ticker))

    let enrichedStocks = stocks
    if (market === 'US' && stocks.length > 0) {
      const nameKrMap = await getUniverseNameMap('US', stocks.map((s) => s.ticker))
      enrichedStocks = stocks.map((s) => ({ ...s, name_kr: nameKrMap[s.ticker] }))
    }

    const riskMap: Record<string, RiskInfo> = {}
    for (const stock of enrichedStocks) {
      const barsAsOfEntry = filterBarsAsOf(priceHistory[stock.ticker] ?? [], regimeRow.date)
      riskMap[stock.ticker] = computeStopTarget(barsAsOfEntry, stock.close)
    }

    return { market, label, universe, date: regimeRow.date, regime: regimeRow.regime, sectors, stocks: enrichedStocks, priceHistory, riskMap, error: null }
  } catch (cause) {
    return {
      market,
      label,
      universe,
      date: null,
      regime: null,
      sectors: [],
      stocks: [],
      priceHistory: {},
      riskMap: {},
      error: cause instanceof Error ? cause.message : '데이터를 불러오지 못했습니다.',
    }
  }
}

function RegimePill({ regime }: { regime: Regime | null }) {
  if (regime === null) {
    return (
      <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500">
        데이터 없음
      </span>
    )
  }
  if (regime === 'bull') {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
        상승장
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-600">
      하락장
    </span>
  )
}

function RegimeCriteria({ regime }: { regime: Regime | null }) {
  if (regime === null) return null
  if (regime === 'bull') {
    return (
      <p className="mt-0.5 text-xs text-gray-400">
        종가 &gt; 50일선 &gt; 200일선 — 상승 추세 확인 ✓
      </p>
    )
  }
  return (
    <p className="mt-0.5 text-xs text-gray-400">
      종가 &gt; 50일선 &gt; 200일선 조건 미충족 — 신중한 접근 권고
    </p>
  )
}

async function HomeContent() {
  await connection()
  const [sections, usdKrwRate] = await Promise.all([
    Promise.all(MARKETS.map(({ market, label, universe }) => loadMarketSection(market, label, universe))),
    fetchUsdKrwRate(),
  ])

  return (
    <>
      {sections.map((section) => (
        <section key={section.market} className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-gray-900">{section.label} 시장</h2>
              <RegimePill regime={section.regime} />
            </div>
            <p className="mt-0.5 text-xs text-gray-400">{section.universe} 탐색</p>
            <RegimeCriteria regime={section.regime} />
            {section.date && (
              <p className="mt-0.5 text-xs text-gray-400">기준: {section.date}</p>
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
                      stop={section.riskMap[stock.ticker]?.stop ?? null}
                      target={section.riskMap[stock.ticker]?.target ?? null}
                      riskReward={section.riskMap[stock.ticker]?.riskReward ?? null}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      ))}

      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-700">스크리닝 기준</h3>
        <table className="mt-3 w-full border-collapse text-xs text-gray-600">
          <tbody className="divide-y divide-gray-50">
            <tr>
              <td className="py-1.5 pr-4 font-medium text-gray-500 whitespace-nowrap">시장 분위기</td>
              <td className="py-1.5">지수 종가 &gt; 50일선 &gt; 200일선 (상승장 확인)</td>
            </tr>
            <tr>
              <td className="py-1.5 pr-4 font-medium text-gray-500 whitespace-nowrap">주도 섹터</td>
              <td className="py-1.5">최근 5일 거래대금 기준 상위 3개 섹터에 속한 종목</td>
            </tr>
            <tr>
              <td className="py-1.5 pr-4 font-medium text-gray-500 whitespace-nowrap">시가총액</td>
              <td className="py-1.5">한국 3,000억원 이상 / 미국 2억달러 이상</td>
            </tr>
            <tr>
              <td className="py-1.5 pr-4 font-medium text-gray-500 whitespace-nowrap">장기 추세</td>
              <td className="py-1.5">60일 이동평균선 우상향 + 현재가 &gt; 60일선</td>
            </tr>
            <tr>
              <td className="py-1.5 pr-4 font-medium text-gray-500 whitespace-nowrap">단기 눌림</td>
              <td className="py-1.5">20일선 ≤ 현재가 ≤ 10일선 (눌림목 구간)</td>
            </tr>
            <tr>
              <td className="py-1.5 pr-4 font-medium text-gray-500 whitespace-nowrap">RSI</td>
              <td className="py-1.5">40 ~ 60 구간</td>
            </tr>
            <tr>
              <td className="py-1.5 pr-4 font-medium text-gray-500 whitespace-nowrap">거래량</td>
              <td className="py-1.5">최근 5일 평균 거래량 &lt; 직전 20일 평균 (매도 압력 약화)</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-3 text-xs text-gray-400">
          매일 오전 8:00 (KST)에 실행되며, 국내 개장(오전 9시) 이전이라 전 영업일 종가를 기준으로 스크리닝합니다.
          (시가·장중가 아님, GitHub Actions 스케줄 특성상 몇 분 정도 지연될 수 있습니다.)
        </p>
      </div>
    </>
  )
}

export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl space-y-5 px-4 py-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">눌림목 매수 스크리너</h1>
        <p className="text-sm text-gray-500">
          상승장에서 주도 섹터의 눌림목 구간에 있는 종목을 매일 추려 드립니다.
        </p>
      </div>

      <Suspense fallback={<p className="py-16 text-center text-muted-foreground">로딩 중...</p>}>
        <HomeContent />
      </Suspense>
    </main>
  )
}
