import { cacheLife } from 'next/cache'
import YahooFinance from 'yahoo-finance2'
import { createServerSupabaseClient } from '@/lib/supabase'
import { fetchUsdKrwRate } from '@/lib/queries/shared'
import { getMonthlyPriceHistory } from '@/lib/queries/opportunities'
import type { DailyReportResult, DailyReportResponse } from '@/lib/types'

// 추천 종목(러셀 3000 포함)은 stock_universe에 없는 종목이 있어 시총을 Yahoo에서
// 일괄 조회한다. 탭을 열 때마다 재조회하지 않도록 시간 단위로 캐시. 실패 시 throw해
// 캐시에 남기지 않고, 호출부에서 빈 맵으로 폴백한다.
async function getUsMarketCaps(tickers: string[]): Promise<Record<string, number>> {
  'use cache'
  cacheLife('hours')
  const yf = new YahooFinance()
  const quotes = (await yf.quote(tickers)) as unknown as Array<{ symbol?: string; marketCap?: number }>
  const map: Record<string, number> = {}
  for (const q of quotes) {
    if (q.symbol && typeof q.marketCap === 'number' && q.marketCap > 0) map[q.symbol] = q.marketCap
  }
  return map
}

export async function GET() {
  const supabase = createServerSupabaseClient()

  // 파이프라인이 사전 계산해둔 패턴 매칭 결과 조회
  const { data: matchData, error: matchErr } = await supabase
    .from('pattern_match_results')
    .select(
      'ticker, name, sector, similarity, matched_standard, matched_standard_ticker, matched_bottom, volume_triggered, computed_at',
    )
    .order('rank', { ascending: true })
    .limit(20)

  if (matchErr) return Response.json({ error: matchErr.message }, { status: 500 })
  if (!matchData || matchData.length === 0) {
    return Response.json(
      { error: '패턴 매칭 데이터가 없습니다. 파이프라인을 먼저 실행해 주세요.' },
      { status: 404 },
    )
  }

  // sector가 null인 종목은 stock_universe에서 보조 조회 (Russell3000 전용 종목 대응)
  const nullSectorTickers = matchData.filter((m) => !m.sector).map((m) => m.ticker)
  if (nullSectorTickers.length > 0) {
    const { data: sectorData } = await supabase
      .from('stock_universe')
      .select('ticker, sector')
      .eq('market', 'US')
      .in('ticker', nullSectorTickers)
    const sectorMap = new Map(
      (sectorData ?? []).filter((r) => r.sector).map((r) => [r.ticker, r.sector]),
    )
    for (const m of matchData) {
      if (!m.sector) m.sector = sectorMap.get(m.ticker) ?? null
    }
  }

  const tickers = matchData.map((m) => m.ticker)

  // 한글명 보조 조회 (stock_universe에서)
  const { data: nameKrData } = await supabase
    .from('stock_universe')
    .select('ticker, name_kr')
    .eq('market', 'US')
    .in('ticker', tickers)
  const nameKrMap = new Map(
    (nameKrData ?? [])
      .filter((r): r is { ticker: string; name_kr: string } => !!r.name_kr)
      .map((r) => [r.ticker, r.name_kr]),
  )

  const [histByTicker, usdKrwRate, marketCaps] = await Promise.all([
    getMonthlyPriceHistory('US', tickers),
    fetchUsdKrwRate(),
    getUsMarketCaps(tickers).catch(() => ({}) as Record<string, number>),
  ])

  const results: DailyReportResult[] = matchData.map((m) => ({
    ticker: m.ticker,
    name: m.name,
    name_kr: nameKrMap.get(m.ticker) ?? null,
    sector: m.sector ?? null,
    similarity: m.similarity,
    matchedStandard: m.matched_standard,
    matchedStandardTicker: m.matched_standard_ticker,
    matchedBottom: m.matched_bottom,
    volumeTriggered: m.volume_triggered,
    history: histByTicker[m.ticker] ?? [],
    marketCap: marketCaps[m.ticker] ?? null,
  }))

  return Response.json({
    generatedAt: matchData[0]?.computed_at ?? new Date().toISOString(),
    results,
    usdKrwRate,
  } satisfies DailyReportResponse)
}
