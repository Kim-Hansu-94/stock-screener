import { Suspense } from 'react'
import { connection } from 'next/server'
import { LoadingFallback } from '@/components/LoadingFallback'
import { EtfWatchCard } from '@/components/EtfWatchCard'
import { fetchPriceRowsPaged } from '@/lib/queries/shared'
import { getMarketIndexSnapshots } from '@/lib/queries/marketOverview'
import { getEtfHoldings } from '@/lib/queries/etfHoldings'
import { DISTRIBUTIONS, analyzeExDates, summarizeDistributions } from '@/lib/etfDistribution'
import {
  ETF_MARKET,
  ETF_TICKER,
  assessProxyBasket,
  assessStopSignals,
  buildTrancheGuide,
  checkSustainedGreen,
  judgedHoldings,
  type ProxyTicker,
} from '@/lib/etfEntryCheck'
import type { PriceHistoryRow } from '@/lib/types'

// A/B/C 판정 최소치(66거래일)보다 넉넉히 받아온다. 주말·휴장을 감안해 달력일로 계산.
const LOOKBACK_DAYS = 220

async function EtfWatchContent() {
  await connection()

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  // 구성종목은 리밸런싱으로 바뀌므로 **먼저 받아와야** 어느 종목의 일봉을 받을지 정해진다.
  const holdingsResult = await getEtfHoldings()
  // 판정은 비중 상위 8개로만 한다(JUDGED_HOLDINGS_COUNT) — 하위 종목은 서로 비중이
  // 거의 같아 신호등을 흔들기만 한다는 사용자 판단. 목록 자체는 15개를 그대로 두고
  // (리밸런싱 알람의 기준이고, "ETF의 몇 %를 보는지" 적을 근거다) 여기서만 좁힌다.
  const judged = judgedHoldings(holdingsResult.holdings)
  const proxyTickers = judged.map((h) => h.ticker)

  // 490590 일봉은 분배금 계산 때문에 더 멀리까지 받는다 — 가장 오래된 배당락일의 **전날** 종가가
  // 필요하다(휴장을 감안해 열흘 여유). 220일에 묶어 두면 분배금이 쌓일수록 옛 배당락일이 범위를
  // 벗어나 '일봉이 없다'로 조용히 잘못 표시된다.
  const oldestExDate = DISTRIBUTIONS.map((d) => d.exDate).sort()[0]
  let etfCutoffStr = cutoffStr
  if (oldestExDate) {
    const from = new Date(oldestExDate)
    from.setDate(from.getDate() - 10)
    const fromStr = from.toISOString().slice(0, 10)
    if (fromStr < etfCutoffStr) etfCutoffStr = fromStr
  }

  const columns = 'ticker, market, date, open, high, low, close, volume'
  const [proxyRows, etfRows, indexSnapshots] = await Promise.all([
    fetchPriceRowsPaged<PriceHistoryRow>('US', proxyTickers, columns, cutoffStr),
    fetchPriceRowsPaged<PriceHistoryRow>(ETF_MARKET, [ETF_TICKER], columns, etfCutoffStr),
    getMarketIndexSnapshots(),
  ])

  const proxyBars = {} as Record<ProxyTicker, PriceHistoryRow[]>
  for (const t of proxyTickers) {
    proxyBars[t] = proxyRows.filter((r) => r.ticker === t).sort((a, b) => a.date.localeCompare(b.date))
  }
  const etfBars = etfRows.filter((r) => r.ticker === ETF_TICKER).sort((a, b) => a.date.localeCompare(b.date))

  const proxyAssessment = assessProxyBasket(proxyBars, judged)
  const sustainedGreen = checkSustainedGreen(proxyBars, judged)
  const tranches = buildTrancheGuide(proxyAssessment, sustainedGreen)

  const tenYearYield = indexSnapshots.find((s) => s.index_name === '미국10년물') ?? null
  const nasdaq = indexSnapshots.find((s) => s.index_name === '나스닥') ?? null
  const stopSignals = assessStopSignals(
    etfBars,
    proxyBars,
    tenYearYield ? { close: tenYearYield.close, prevClose: tenYearYield.prev_close } : null,
    judged,
  )

  const etfLatest = etfBars.length > 0 ? etfBars[etfBars.length - 1] : null

  // 분배금은 손으로 적은 목록(lib/etfDistribution.ts)이고, 배당락일 등락은 일봉에서 계산한다.
  const distributions = analyzeExDates(etfBars)
  const distributionSummary = summarizeDistributions(distributions, etfBars)

  return (
    <EtfWatchCard
      holdings={holdingsResult}
      proxyAssessment={proxyAssessment}
      etfLatest={etfLatest ? { close: etfLatest.close, date: etfLatest.date } : null}
      hasEtfData={etfBars.length > 0}
      tranches={tranches}
      stopSignals={stopSignals}
      tenYearYield={tenYearYield}
      nasdaq={nasdaq}
      distributions={distributions}
      distributionSummary={distributionSummary}
    />
  )
}

export default function EtfWatchPage() {
  return (
    <main className="mx-auto max-w-4xl space-y-5 px-4 py-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">490590 매수체크</h1>
        <p className="text-sm text-muted-foreground">
          RISE 미국AI밸류체인데일리고정커버드콜(490590)을 살 때가 됐는지, 이 ETF가 실제로
          담고 있는 미국 AI 밸류체인 대장주들의 추세로 판단하는 개인 체크리스트입니다.
        </p>
      </div>

      <Suspense fallback={<LoadingFallback />}>
        <EtfWatchContent />
      </Suspense>
    </main>
  )
}
