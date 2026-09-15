import { Suspense } from 'react'
import { connection } from 'next/server'
import { LoadingFallback } from '@/components/LoadingFallback'
import { EtfWatchCard } from '@/components/EtfWatchCard'
import { fetchPriceRowsPaged } from '@/lib/queries/shared'
import { getMarketIndexSnapshots } from '@/lib/queries/marketOverview'
import {
  ETF_MARKET,
  ETF_TICKER,
  PROXY_TICKERS,
  assessProxyBasket,
  assessStopSignals,
  buildTrancheGuide,
  classifyStage,
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

  const columns = 'ticker, market, date, open, high, low, close, volume'
  const [proxyRows, etfRows, indexSnapshots] = await Promise.all([
    fetchPriceRowsPaged<PriceHistoryRow>('US', [...PROXY_TICKERS], columns, cutoffStr),
    fetchPriceRowsPaged<PriceHistoryRow>(ETF_MARKET, [ETF_TICKER], columns, cutoffStr),
    getMarketIndexSnapshots(),
  ])

  const proxyBars = {} as Record<ProxyTicker, PriceHistoryRow[]>
  for (const t of PROXY_TICKERS) {
    proxyBars[t] = proxyRows.filter((r) => r.ticker === t).sort((a, b) => a.date.localeCompare(b.date))
  }
  const etfBars = etfRows.filter((r) => r.ticker === ETF_TICKER).sort((a, b) => a.date.localeCompare(b.date))

  const proxyAssessment = assessProxyBasket(proxyBars)
  const etfStage = classifyStage(etfBars)
  const tranches = buildTrancheGuide(proxyAssessment, etfStage, etfBars)

  const tenYearYield = indexSnapshots.find((s) => s.index_name === '미국10년물') ?? null
  const nasdaq = indexSnapshots.find((s) => s.index_name === '나스닥') ?? null
  const stopSignals = assessStopSignals(
    etfBars,
    proxyBars,
    tenYearYield ? { close: tenYearYield.close, prevClose: tenYearYield.prev_close } : null,
  )

  const etfLatest = etfBars.length > 0 ? etfBars[etfBars.length - 1] : null

  return (
    <EtfWatchCard
      proxyAssessment={proxyAssessment}
      etfStage={etfStage}
      etfLatest={etfLatest ? { close: etfLatest.close, date: etfLatest.date } : null}
      hasEtfData={etfBars.length > 0}
      tranches={tranches}
      stopSignals={stopSignals}
      tenYearYield={tenYearYield}
      nasdaq={nasdaq}
    />
  )
}

export default function EtfWatchPage() {
  return (
    <main className="mx-auto max-w-4xl space-y-5 px-4 py-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">490590 매수체크</h1>
        <p className="text-sm text-muted-foreground">
          RISE 미국AI밸류체인데일리고정커버드콜(490590)을 살 때가 됐는지, 미국 AI 밸류체인
          대장주 5개의 추세로 판단하는 개인 체크리스트입니다.
        </p>
      </div>

      <Suspense fallback={<LoadingFallback />}>
        <EtfWatchContent />
      </Suspense>
    </main>
  )
}
