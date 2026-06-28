import { createServerSupabaseClient } from '@/lib/supabase'

export async function GET() {
  const supabase = createServerSupabaseClient()

  const cutoff = new Date()
  cutoff.setFullYear(cutoff.getFullYear() - 3)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  // 1. US universe: 전체 종목 수
  const { data: universe } = await supabase
    .from('stock_universe')
    .select('ticker, index_membership')
    .eq('market', 'US')

  const byMembership: Record<string, number> = {}
  for (const row of universe ?? []) {
    const key = row.index_membership ?? '(null)'
    byMembership[key] = (byMembership[key] ?? 0) + 1
  }

  // 2. 3년치 US price history 행 수
  const { count: histCount } = await supabase
    .from('stock_price_history')
    .select('*', { count: 'exact', head: true })
    .eq('market', 'US')
    .gte('date', cutoffStr)

  // 3. S&P500/NASDAQ100 티커 5개 샘플 드로다운
  const sampleTickers = (universe ?? [])
    .filter((r) => r.index_membership === 'S&P500' || r.index_membership === 'NASDAQ100')
    .slice(0, 5)
    .map((r) => r.ticker as string)

  const samples = []
  for (const ticker of sampleTickers) {
    const { data: rows } = await supabase
      .from('stock_price_history')
      .select('date, close')
      .eq('market', 'US')
      .eq('ticker', ticker)
      .gte('date', cutoffStr)
      .order('date', { ascending: true })
    if (!rows || rows.length === 0) {
      samples.push({ ticker, rowCount: 0 })
      continue
    }
    const closes = rows.map((r) => r.close as number)
    const high3y = Math.max(...closes)
    const current = closes[closes.length - 1]
    const drawdown = (((high3y - current) / high3y) * 100).toFixed(1)
    samples.push({ ticker, rowCount: rows.length, high3y, current, drawdown })
  }

  return Response.json({ cutoffStr, universeTotalUS: universe?.length ?? 0, byMembership, histCount3yUS: histCount, samples })
}
