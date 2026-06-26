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

  // Fetch NASDAQ100 universe stocks (미래먹거리 proxy)
  const { data: universeData, error: universeErr } = await supabase
    .from('stock_universe')
    .select('ticker, name, sector, index_membership')
    .eq('market', 'US')
    .eq('index_membership', 'NASDAQ100')
  if (universeErr) return Response.json({ error: universeErr.message }, { status: 500 })

  const tickers = (universeData ?? []).map((r) => r.ticker)
  if (tickers.length === 0) return Response.json([])

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 120)
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
    const high120d = Math.max(...closes)
    const currentClose = closes[closes.length - 1]
    const drawdown = ((high120d - currentClose) / high120d) * 100

    if (drawdown < minDrawdown || drawdown > maxDrawdown) continue

    const meta = universeMap.get(ticker)
    results.push({
      ticker,
      name: meta?.name ?? ticker,
      sector: meta?.sector ?? null,
      index_membership: meta?.index_membership ?? null,
      currentClose,
      high120d,
      drawdown,
      history: rows,
    })
  }

  results.sort((a, b) => b.drawdown - a.drawdown)
  return Response.json(results)
}
