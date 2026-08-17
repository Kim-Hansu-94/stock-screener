import { Suspense } from 'react'
import { connection } from 'next/server'
import { cacheLife, cacheTag } from 'next/cache'
import { SCREENER_CACHE_TAG, fetchUsdKrwRate } from '@/lib/queries/shared'
import {
  getFundamentals,
  getLongMonthlyHistory,
  getMonthlyPriceHistory,
  getOpportunitySnapshot,
} from '@/lib/queries/opportunities'
import { getUniverseMarketCaps } from '@/lib/queries/universe'
import { buildLongTermContext } from '@/lib/longTermContext'
import type { Market, OpportunitySnapshotRow, OpportunityStockRow } from '@/lib/types'
import { DiscoverTabs } from './DiscoverTabs'

// 조정폭 집계·일봉 수집·점수 계산은 파이프라인이 미리 끝내 opportunity_snapshot에
// 넣어둔다(pipeline/src/opportunities.py). 여기서는 그 결과에 차트·실적·시총만
// 붙인다 — 예전처럼 요청마다 유니버스 전체를 훑지 않는다.
async function attachDetails(
  rows: OpportunitySnapshotRow[],
  market: Market,
): Promise<OpportunityStockRow[]> {
  if (rows.length === 0) return []
  const tickers = rows.map((r) => r.ticker)

  const [monthly, longMonthly, marketCaps, fundamentals] = await Promise.all([
    getMonthlyPriceHistory(market, tickers),
    getLongMonthlyHistory(market, tickers),
    getUniverseMarketCaps(market, tickers),
    getFundamentals(market, tickers),
  ])

  return rows.map((row) => {
    const recentMonthly = monthly[row.ticker] ?? []
    const longTerm = buildLongTermContext(
      longMonthly[row.ticker] ?? [],
      recentMonthly,
      row.current_close,
      row.high3y,
    )
    return {
      ticker: row.ticker,
      name: row.name ?? row.ticker,
      name_kr: row.name_kr ?? undefined,
      sector: row.sector,
      index_membership: row.index_membership,
      market,
      currentClose: row.current_close,
      high3y: row.high3y,
      drawdown: row.drawdown,
      history: longTerm.monthly.length > 0 ? longTerm.monthly : recentMonthly,
      score: row.score,
      daysSinceLow: row.days_since_low ?? 0,
      vcp: row.vcp ?? false,
      higherLows: row.higher_lows ?? false,
      volumeDry: row.volume_dry ?? false,
      alignedMAs: row.aligned_mas ?? false,
      volumeTrigger: row.volume_trigger ?? false,
      asOfDate: row.as_of_date,
      marketCap: marketCaps[row.ticker] ?? null,
      longTermHigh: longTerm.longTermHigh,
      longTermDrawdown: longTerm.longTermDrawdown,
      longTermDeclining: longTerm.longTermDeclining,
      hasLongHistory: longTerm.hasLongHistory,
      fundamentals: fundamentals[row.ticker] ?? null,
    }
  })
}

async function loadOpportunities(): Promise<OpportunityStockRow[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const snapshot = await getOpportunitySnapshot()
  if (snapshot.length === 0) return []

  const [us, kr] = await Promise.all([
    attachDetails(snapshot.filter((r) => r.market === 'US'), 'US'),
    attachDetails(snapshot.filter((r) => r.market === 'KR'), 'KR'),
  ])

  // 매수 매력도 순 정렬, 동점이면 하락률 큰 순
  return [...us, ...kr].sort((a, b) => b.score - a.score || b.drawdown - a.drawdown)
}

async function DiscoverContent() {
  await connection()

  // 환율과 기회 종목은 서로 무관하므로 함께 기다린다 (순차 대기 제거)
  const [usdKrwRate, opportunityResult] = await Promise.all([
    fetchUsdKrwRate(),
    loadOpportunities().then(
      (rows) => ({ rows, error: null as string | null }),
      (cause: unknown) => ({
        rows: [] as OpportunityStockRow[],
        error: cause instanceof Error ? cause.message : '데이터를 불러오지 못했습니다.',
      }),
    ),
  ])

  return (
    <DiscoverTabs
      opportunities={opportunityResult.rows}
      opportunityError={opportunityResult.error}
      usdKrwRate={usdKrwRate}
    />
  )
}

export default function DiscoverPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Suspense fallback={<p className="py-16 text-center text-muted-foreground">로딩 중...</p>}>
        <DiscoverContent />
      </Suspense>
    </main>
  )
}
