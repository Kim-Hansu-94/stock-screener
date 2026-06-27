import type { NextRequest } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase'
import type { OpportunityStockRow, PriceHistoryRow } from '@/lib/types'

const DEFAULT_MIN_DRAWDOWN = 20
const DEFAULT_MAX_DRAWDOWN = 60

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const minDrawdown = Number(searchParams.get('min') ?? DEFAULT_MIN_DRAWDOWN)
  const maxDrawdown = Number(searchParams.get('max') ?? DEFAULT_MAX_DRAWDOWN)

  const supabase = createServerSupabaseClient()

  // NASDAQ100 종목 조회 — S&P500과 중복 시 S&P500으로 태깅되므로 둘 다 포함
  const { data: universeData, error: universeErr } = await supabase
    .from('stock_universe')
    .select('ticker, name, sector, index_membership')
    .eq('market', 'US')
    .in('index_membership', ['NASDAQ100', 'S&P500'])
  if (universeErr) return Response.json({ error: universeErr.message }, { status: 500 })

  const tickers = (universeData ?? []).map((r) => r.ticker)
  if (tickers.length === 0) return Response.json([])

  const cutoff = new Date()
  cutoff.setFullYear(cutoff.getFullYear() - 3)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const { data: histData, error: histErr } = await supabase
    .from('stock_price_history')
    .select('ticker, date, open, high, low, close, volume, market')
    .eq('market', 'US')
    .in('ticker', tickers)
    .gte('date', cutoffStr)
    .order('date', { ascending: true })
  if (histErr) return Response.json({ error: histErr.message }, { status: 500 })

  // Group history by ticker
  const grouped: Record<string, PriceHistoryRow[]> = {}
  for (const row of (histData ?? []) as PriceHistoryRow[]) {
    grouped[row.ticker] ??= []
    grouped[row.ticker].push(row)
  }

  const universeMap = new Map(
    (universeData ?? []).map((r) => [r.ticker, r]),
  )

  // Compute drawdown from 120-day high
  const results: OpportunityStockRow[] = []
  for (const [ticker, rows] of Object.entries(grouped)) {
    if (rows.length < 5) continue
    const closes = rows.map((r) => r.close)
    const highPeak = Math.max(...closes)
    const currentClose = closes[closes.length - 1]
    const drawdown = ((highPeak - currentClose) / highPeak) * 100

    if (drawdown < minDrawdown || drawdown > maxDrawdown) continue

    const meta = universeMap.get(ticker)
    results.push({
      ticker,
      name: meta?.name ?? ticker,
      sector: meta?.sector ?? null,
      index_membership: meta?.index_membership ?? null,
      market: 'US',
      currentClose,
      high3y: highPeak,
      drawdown,
      history: rows,
    })
  }

  results.sort((a, b) => b.drawdown - a.drawdown)
  return Response.json(results)
}
