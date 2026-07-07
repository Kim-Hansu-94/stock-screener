import type { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServerSupabaseClient } from '@/lib/supabase'
import type { Market, OpportunityStockRow } from '@/lib/types'

const DEFAULT_MIN_DRAWDOWN = 20
const DEFAULT_MAX_DRAWDOWN = 60
// Supabase caps each response at its `max-rows` setting (default 1000), so the
// page size must match that cap — a larger value makes the loop terminate after
// the first page and silently drops all but the first ~1000 rows.
const PAGE_SIZE = 1_000

async function computeOpportunities(
  supabase: SupabaseClient,
  market: Market,
  memberships: string[],
  cutoffStr: string,
  minDrawdown: number,
  maxDrawdown: number,
): Promise<{ results?: OpportunityStockRow[]; error?: string }> {
  const { data: universeData, error: universeErr } = await supabase
    .from('stock_universe')
    .select('ticker, name, sector, index_membership')
    .eq('market', market)
    .in('index_membership', memberships)
  if (universeErr) return { error: universeErr.message }

  const tickers = (universeData ?? []).map((r) => r.ticker)
  if (tickers.length === 0) return { results: [] }

  // Paginate to bypass Supabase's default 1000-row limit
  const allRows: { ticker: string; date: string; close: number }[] = []
  let from = 0
  while (true) {
    const { data, error } = await supabase
      .from('stock_price_history')
      .select('ticker, date, close')
      .eq('market', market)
      .in('ticker', tickers)
      .gte('date', cutoffStr)
      .order('ticker', { ascending: true })
      .order('date', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) return { error: error.message }
    if (!data?.length) break
    allRows.push(...(data as typeof allRows))
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  // Group by ticker and compute drawdown
  const grouped: Record<string, { ticker: string; date: string; close: number }[]> = {}
  for (const row of allRows) {
    grouped[row.ticker] ??= []
    grouped[row.ticker].push(row)
  }

  const universeMap = new Map(
    (universeData ?? []).map((r) => [r.ticker, r]),
  )

  const results: OpportunityStockRow[] = []
  for (const [ticker, rows] of Object.entries(grouped)) {
    if (rows.length < 5) continue
    const closes = rows.map((r) => r.close)
    const high3y = Math.max(...closes)
    const currentClose = closes[closes.length - 1]
    const drawdown = ((high3y - currentClose) / high3y) * 100

    if (drawdown < minDrawdown || drawdown > maxDrawdown) continue

    const meta = universeMap.get(ticker)
    results.push({
      ticker,
      name: meta?.name ?? ticker,
      sector: meta?.sector ?? null,
      index_membership: meta?.index_membership ?? null,
      market,
      currentClose,
      high3y,
      drawdown,
      history: [],
    })
  }

  return { results }
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const minDrawdown = Number(searchParams.get('min') ?? DEFAULT_MIN_DRAWDOWN)
  const maxDrawdown = Number(searchParams.get('max') ?? DEFAULT_MAX_DRAWDOWN)

  const supabase = createServerSupabaseClient()

  const cutoff = new Date()
  cutoff.setFullYear(cutoff.getFullYear() - 3)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const [us, kr] = await Promise.all([
    computeOpportunities(supabase, 'US', ['NASDAQ100', 'S&P500'], cutoffStr, minDrawdown, maxDrawdown),
    computeOpportunities(supabase, 'KR', ['KOSPI'], cutoffStr, minDrawdown, maxDrawdown),
  ])

  if (us.error) return Response.json({ error: us.error }, { status: 500 })
  if (kr.error) return Response.json({ error: kr.error }, { status: 500 })

  const results = [...(us.results ?? []), ...(kr.results ?? [])]
  results.sort((a, b) => b.drawdown - a.drawdown)
  return Response.json(results)
}
