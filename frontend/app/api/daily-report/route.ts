import { createServerSupabaseClient } from '@/lib/supabase'
import type { PriceHistoryRow, DailyReportResult, DailyReportResponse } from '@/lib/types'

function toMonthlyOHLCV(daily: PriceHistoryRow[]): PriceHistoryRow[] {
  const months: Record<string, PriceHistoryRow[]> = {}
  for (const row of daily) {
    const key = row.date.slice(0, 7)
    ;(months[key] ??= []).push(row)
  }
  return Object.entries(months)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, rows]) => ({
      ticker: rows[0].ticker,
      market: rows[0].market,
      date: rows[rows.length - 1].date,
      open: rows[0].open,
      high: Math.max(...rows.map((r) => r.high)),
      low: Math.min(...rows.map((r) => r.low)),
      close: rows[rows.length - 1].close,
      volume: rows.reduce((sum, r) => sum + r.volume, 0),
    }))
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

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 1095)

  const { data: histData, error: histErr } = await supabase
    .from('stock_price_history')
    .select('ticker, date, close, open, high, low, volume, market')
    .eq('market', 'US')
    .in('ticker', tickers)
    .gte('date', cutoff.toISOString().slice(0, 10))
    .order('date', { ascending: true })

  if (histErr) return Response.json({ error: histErr.message }, { status: 500 })

  const histByTicker: Record<string, PriceHistoryRow[]> = {}
  for (const row of (histData ?? []) as PriceHistoryRow[]) {
    histByTicker[row.ticker] ??= []
    histByTicker[row.ticker].push(row)
  }

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
    history: toMonthlyOHLCV(histByTicker[m.ticker] ?? []),
  }))

  return Response.json({
    generatedAt: matchData[0]?.computed_at ?? new Date().toISOString(),
    results,
  } satisfies DailyReportResponse)
}
