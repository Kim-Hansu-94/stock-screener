import { Suspense } from 'react'
import { connection } from 'next/server'
import { LeadingSectors } from '@/components/LeadingSectors'
import { LoadingFallback } from '@/components/LoadingFallback'
import { StockCard } from '@/components/StockCard'
import { WatchlistCard } from '@/components/WatchlistCard'
import { fetchUsdKrwRate } from '@/lib/queries/shared'
import {
  getLatestRegime,
  getLeadingSectors,
  getPriceHistoryByTicker,
  getScreenedStocks,
  getWatchlistStatus,
} from '@/lib/queries/screener'
import { getUniverseNameMap } from '@/lib/queries/universe'
import type { LeadingSectorRow, Market, PriceHistoryRow, Regime, ScreenedStockRow } from '@/lib/types'
import { computeStopTarget, filterBarsAsOf, type RiskResult } from '@/lib/risk'
import { getOpenTickers } from '@/lib/queries/trades'

const MARKETS: { market: Market; label: string; universe: string }[] = [
  { market: 'KR', label: '한국', universe: '코스피 · 코스닥' },
  { market: 'US', label: '미국', universe: 'S&P 1500 · NASDAQ 100' },
]

type RiskInfo = RiskResult

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
      <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
        데이터 없음
      </span>
    )
  }
  if (regime === 'bull') {
    return (
      <span className="inline-flex items-center rounded-md bg-up/10 px-2.5 py-0.5 text-xs font-semibold text-up">
        상승장
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-md bg-down/10 px-2.5 py-0.5 text-xs font-semibold text-down">
      하락장
    </span>
  )
}

function RegimeCriteria({ regime }: { regime: Regime | null }) {
  if (regime === null) return null
  if (regime === 'bull') {
    return (
      <p className="mt-0.5 text-xs text-muted-foreground">
        종가 &gt; 50일선 &gt; 200일선 — 상승 추세 확인 ✓
      </p>
    )
  }
  return (
    <p className="mt-0.5 text-xs text-muted-foreground">
      종가 &gt; 50일선 &gt; 200일선 조건 미충족 — 신중한 접근 권고
    </p>
  )
}

// 카드 하나의 셸(그림자·모서리)만 공유해, 로딩 중에도 자리가 안정적으로 잡히게 한다.
const SECTION_CARD_CLASS =
  'space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]'

function SectionSkeleton() {
  return (
    <div className={SECTION_CARD_CLASS}>
      <LoadingFallback label="불러오는 중..." className="py-8" />
    </div>
  )
}

// 감시 종목·한국장·미국장을 하나의 Suspense로 묶으면 셋 중 가장 느린 쿼리(보통 한국장의
// 종목별 시세 조회) 하나 때문에 먼저 끝난 것도 같이 안 보이고 기다리게 된다. 셋을 독립된
// 컴포넌트 + 각자의 Suspense로 나눠, 끝난 순서대로 스트리밍되게 한다.
async function WatchlistSection() {
  await connection()
  const watchlist = await getWatchlistStatus()
  return <WatchlistCard rows={watchlist} />
}

async function MarketSection({ market, label, universe }: { market: Market; label: string; universe: string }) {
  await connection()
  const [section, openTickers, usdKrwRate] = await Promise.all([
    loadMarketSection(market, label, universe),
    getOpenTickers(),
    // 원화 환산은 미국장 카드에서만 쓰인다 — 한국장에서 굳이 환율 API를 기다리지 않는다.
    market === 'US' ? fetchUsdKrwRate() : Promise.resolve(1),
  ])

  return (
    <section className={SECTION_CARD_CLASS}>
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-foreground">{section.label} 시장</h2>
          <RegimePill regime={section.regime} />
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{section.universe} 탐색</p>
        <RegimeCriteria regime={section.regime} />
        {section.date && (
          <p className="mt-0.5 text-xs text-muted-foreground">기준: {section.date}</p>
        )}
      </div>

      {section.error && <p className="text-sm text-destructive">{section.error}</p>}

      {!section.error && (
        <>
          <LeadingSectors marketLabel={section.label} sectors={section.sectors} />

          {section.stocks.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              오늘은 표시할 후보가 없습니다 (데이터 부족 또는 후보군 없음).
            </p>
          ) : (
            <>
              {!section.stocks.some((s) => s.passed) && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  오늘 전 조건을 충족한 종목은 없습니다. 아래는 조건에 가장 근접한 상위
                  후보이며, 어떤 조건이 미달인지 카드에 표시됩니다. 참고용으로만 보세요.
                </p>
              )}
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
                    riskReason={section.riskMap[stock.ticker]?.reason ?? 'insufficient_data'}
                    riskFrame={section.riskMap[stock.ticker]?.frame ?? null}
                    wayResistance={section.riskMap[stock.ticker]?.wayResistance ?? null}
                    targetBasis={section.riskMap[stock.ticker]?.targetBasis ?? null}
                    owned={openTickers.has(`${section.market}:${stock.ticker}`)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}

// 데이터에 의존하지 않는 정적 안내 카드 — Suspense 밖에 둬 정적 셸의 일부로 즉시 그려지게 한다.
function ScreeningCriteria() {
  return (
    <div className={SECTION_CARD_CLASS}>
      <h3 className="text-sm font-semibold text-secondary-foreground">스크리닝 기준</h3>
      <table className="mt-3 w-full border-collapse text-xs text-secondary-foreground">
        <tbody className="divide-y divide-border">
          <tr>
            <td className="py-1.5 pr-4 font-medium text-muted-foreground whitespace-nowrap">대상 종목</td>
            <td className="py-1.5">한국 코스피 · 코스닥 / 미국 S&amp;P 1500 (대형 · 중형 · 소형) + NASDAQ 100</td>
          </tr>
          <tr>
            <td className="py-1.5 pr-4 font-medium text-muted-foreground whitespace-nowrap">시장 분위기</td>
            <td className="py-1.5">지수 종가 &gt; 50일선 &gt; 200일선 (상승장 확인)</td>
          </tr>
          <tr>
            <td className="py-1.5 pr-4 font-medium text-muted-foreground whitespace-nowrap">주도 섹터</td>
            <td className="py-1.5">최근 5일 거래대금 기준 상위 5개 섹터에 속한 종목 (초대형주는 면제: 한국 20조원 · 미국 2,000억달러 이상)</td>
          </tr>
          <tr>
            <td className="py-1.5 pr-4 font-medium text-muted-foreground whitespace-nowrap">시가총액</td>
            <td className="py-1.5">한국 3,000억원 이상 / 미국 20억달러 이상</td>
          </tr>
          <tr>
            <td className="py-1.5 pr-4 font-medium text-muted-foreground whitespace-nowrap">장기 추세</td>
            <td className="py-1.5">60일 이동평균선 우상향 + 현재가 &gt; 60일선 + 현재가 &gt; 200일선</td>
          </tr>
          <tr>
            <td className="py-1.5 pr-4 font-medium text-muted-foreground whitespace-nowrap">단기 눌림</td>
            <td className="py-1.5">20일선 −5% ≤ 현재가 ≤ 10일선 (눌림목 구간)</td>
          </tr>
          <tr>
            <td className="py-1.5 pr-4 font-medium text-muted-foreground whitespace-nowrap">선행 상승</td>
            <td className="py-1.5">최근 60거래일 수익률 +15% 이상 (강한 상승 파동 후의 눌림만)</td>
          </tr>
          <tr>
            <td className="py-1.5 pr-4 font-medium text-muted-foreground whitespace-nowrap">RSI</td>
            <td className="py-1.5">40 ~ 60 구간 + 3일 전보다 상승 중</td>
          </tr>
          <tr>
            <td className="py-1.5 pr-4 font-medium text-muted-foreground whitespace-nowrap">거래량</td>
            <td className="py-1.5">최근 5일 평균 거래량 &lt; 직전 20일 평균의 85% (매도 압력 약화)</td>
          </tr>
          <tr>
            <td className="py-1.5 pr-4 font-medium text-muted-foreground whitespace-nowrap">반등 확인</td>
            <td className="py-1.5">당일 종가 &gt; 전일 고가 (하락 중 매수 방지)</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-3 text-xs text-muted-foreground">
        매일 오전 6:30 (KST)에 파이프라인이 자동 실행됩니다. 미장 마감 직후이자 국내 개장(오전 9시) 이전이라
        전 영업일 종가 기준으로 스크리닝하며, 완료 즉시 사이트 전체 데이터가 함께 갱신됩니다.
        정시 실행이 실패한 날에는 오전 8시·11시 백업 스케줄이 자동으로 다시 실행합니다.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        전 조건 충족 종목이 5개 미만인 날에는 미달 조건이 가장 적은 근접 후보로 5개까지 채워
        보여줍니다. 근접 후보는 카드에 미달 조건이 표시되며(하락장 날은 &lsquo;시장 하락장&rsquo; 포함),
        매수 신호가 아닌 관찰 목록입니다. 추천 이력·성적표에는 전 조건 충족 종목만 집계됩니다.
      </p>
    </div>
  )
}

function TradingGuide() {
  return (
    <div className={SECTION_CARD_CLASS}>
      <h3 className="text-sm font-semibold text-secondary-foreground">추천 매매 방법</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        이 스크리너는 스캘핑용이 아니라 눌림목 스윙 트레이드 구조로 설계되어 있습니다.
      </p>
      <ol className="mt-3 space-y-2.5 text-xs text-secondary-foreground">
        <li className="flex gap-2">
          <span className="font-semibold text-muted-foreground whitespace-nowrap">1. 보유 기간</span>
          <span>
            &quot;1주일&quot; 같은 고정 기간을 정하지 말고, 종목 카드에 표시되는 <b>손절가/목표가에 닿을 때까지 보유</b>합니다.
            목표가는 직전 저항(피벗 고점) 기준이라 하루 만에 도달할 수도, 1~2주 넘게 걸릴 수도 있습니다.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="font-semibold text-muted-foreground whitespace-nowrap">2. 수량 결정</span>
          <span>
            손절 거리(진입가 − 손절가) 기준으로 <b>계좌의 1~2%만 리스크에 걸리도록</b> 수량을 정합니다.
            RSI 40~60 구간 진입은 과매도 반등이 아닌 추세 지속 베팅이므로, 손절을 타이트하게 지키는 것이 중요합니다.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="font-semibold text-muted-foreground whitespace-nowrap">3. 진입 시점</span>
          <span>
            추천은 전 영업일 종가 기준이므로 실제 진입은 다음날 시가가 됩니다.
            <b>시가가 크게 갭업해 있으면</b> 손익비가 이미 나빠진 상태이므로 그런 날은 스킵하거나 소량만 진입합니다.
          </span>
        </li>
        <li className="flex gap-2">
          <span className="font-semibold text-muted-foreground whitespace-nowrap">4. 중도 점검</span>
          <span>
            목표가 도달 전이라도 시장이 하락장으로 바뀌거나 추세가 꺾이면 미리 정리해야 합니다.
            보유 중에는 <b>&quot;보유 종목 점검&quot; 탭</b>에서 이탈 신호를 매일 확인하세요.
          </span>
        </li>
      </ol>
    </div>
  )
}

export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl space-y-5 px-4 py-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">눌림목 매수 스크리너</h1>
        <p className="text-sm text-muted-foreground">
          상승장에서 주도 섹터의 눌림목 구간에 있는 종목을 매일 추려 드립니다.
        </p>
      </div>

      <Suspense fallback={<SectionSkeleton />}>
        <WatchlistSection />
      </Suspense>

      {MARKETS.map(({ market, label, universe }) => (
        <Suspense key={market} fallback={<SectionSkeleton />}>
          <MarketSection market={market} label={label} universe={universe} />
        </Suspense>
      ))}

      <ScreeningCriteria />
      <TradingGuide />
    </main>
  )
}
