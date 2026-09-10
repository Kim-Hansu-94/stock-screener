import { Suspense } from 'react'
import { connection } from 'next/server'
import { cacheLife, cacheTag } from 'next/cache'
import { LoadingFallback } from '@/components/LoadingFallback'
import { SCREENER_CACHE_TAG, fetchUsdKrwRate } from '@/lib/queries/shared'
import {
  getFundamentals,
  getLongMonthlyHistory,
  getMonthlyPriceHistory,
  getOpportunitySnapshot,
} from '@/lib/queries/opportunities'
import {
  getWatchlistStatus,
  getWatchlistTickers,
} from '@/lib/queries/screener'
import { getUniverseMarketCaps } from '@/lib/queries/universe'
import { getKrExtrasSummaries, type KrExtrasSummary } from '@/lib/queries/krExtras'
import { buildLongTermContext } from '@/lib/longTermContext'
import type {
  Market,
  OpportunitySnapshotRow,
  OpportunityStockRow,
  WatchlistStatusRow,
  WatchlistTickerRow,
} from '@/lib/types'
import { DiscoverTabs } from './DiscoverTabs'
import { getOpenTickers } from '@/lib/queries/trades'

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
      qualifiedSince: row.qualified_since,
      breakoutSince: row.breakout_since,
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

/**
 * 매집 감시 데이터 — 아직 사지 않은 관심 종목이 매집 구간에 들어왔는지 보는 쪽.
 * 예전에는 눌림목 페이지에 있었지만, 단기매매인 그 탭과 달리 장기 관점이라
 * 종목발굴 탭으로 옮겼다 (2026-09-06).
 *
 * 이미 보유 중인 종목(category='position')은 여기서 뺀다 — 재는 질문이
 * 완전히 달라서(매집 구간 포착 vs 지지 신호 점검) 눌림목 페이지 상단의
 * 포지션 관리 카드가 따로 맡는다.
 */
async function loadAccumulationWatchlist() {
  const [rows, tickers] = await Promise.all([getWatchlistStatus(), getWatchlistTickers()])

  const accumulationTickers = tickers.filter((t) => t.category !== 'position')
  const positionKeys = new Set(
    tickers.filter((t) => t.category === 'position').map((t) => `${t.market}-${t.ticker}`),
  )
  // 파이프라인은 category를 모른 채 전 종목을 평가하므로, 포지션 관리 종목의
  // 매집 판정 행은 여기서 빼야 같은 종목이 두 화면에 겹쳐 뜨지 않는다.
  const accumulationRows = rows.filter((r) => !positionKeys.has(`${r.market}-${r.ticker}`))

  // 차트에 쓸 일봉은 여기서 받지 않는다 — 종목을 펼쳤을 때 LazyStockChart가
  // /api/price-history로 그 종목만 받아온다. 예전에는 감시 종목 전부(최대 30개)의
  // 500봉을 미리 받아 클라이언트까지 내려보냈고, 그게 이 탭이 느린 가장 큰 이유였다.
  // 접힌 카드에도 수급·목표가·자사주가 보이게 요약만 미리 받는다(종목당 숫자 몇 개).
  // 평가 전 종목(방금 추가해서 watchlist_status가 아직 없는 것)도 포함해야 한다.
  const krTickers = new Set<string>()
  for (const r of accumulationRows) if (r.market === 'KR') krTickers.add(r.ticker)
  for (const t of accumulationTickers) if (t.market === 'KR') krTickers.add(t.ticker)
  const krExtras = await getKrExtrasSummaries([...krTickers])

  return { accumulationRows, accumulationTickers, krExtras }
}

async function DiscoverContent() {
  await connection()

  // 환율·기회 종목·감시 종목은 서로 무관하므로 함께 기다린다 (순차 대기 제거)
  const [usdKrwRate, openTickers, opportunityResult, watchlist] = await Promise.all([
    fetchUsdKrwRate(),
    getOpenTickers(),
    loadOpportunities().then(
      (rows) => ({ rows, error: null as string | null }),
      (cause: unknown) => ({
        rows: [] as OpportunityStockRow[],
        error: cause instanceof Error ? cause.message : '데이터를 불러오지 못했습니다.',
      }),
    ),
    // 감시 종목이 실패해도 나머지 탭은 그대로 보여준다.
    loadAccumulationWatchlist().catch(() => ({
      accumulationRows: [] as WatchlistStatusRow[],
      accumulationTickers: [] as WatchlistTickerRow[],
      krExtras: {} as Record<string, KrExtrasSummary>,
    })),
  ])

  return (
    <DiscoverTabs
      opportunities={opportunityResult.rows}
      opportunityError={opportunityResult.error}
      usdKrwRate={usdKrwRate}
      ownedTickers={[...openTickers]}
      watchlistRows={watchlist.accumulationRows}
      watchlistTickers={watchlist.accumulationTickers}
      watchlistKrExtras={watchlist.krExtras}
    />
  )
}

export default function DiscoverPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Suspense fallback={<LoadingFallback />}>
        <DiscoverContent />
      </Suspense>
    </main>
  )
}
