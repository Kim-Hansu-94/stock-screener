import { createServerSupabaseClient } from '@/lib/supabase'

export async function GET() {
  const supabase = createServerSupabaseClient()

  // 1. stock_universe 집계
  const { data: universeStats, error: uErr } = await supabase
    .from('stock_universe')
    .select('market, index_membership')

  // 2. stock_price_history 샘플 집계
  const { count: histCount, error: hErr } = await supabase
    .from('stock_price_history')
    .select('ticker', { count: 'exact', head: true })
    .eq('market', 'US')

  // 3. 최근 3년 cutoff 이후 US 행 수
  const cutoff = new Date()
  cutoff.setFullYear(cutoff.getFullYear() - 3)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  const { count: histCount3y, error: h3Err } = await supabase
    .from('stock_price_history')
    .select('ticker', { count: 'exact', head: true })
    .eq('market', 'US')
    .gte('date', cutoffStr)

  // 4. 샘플 드로다운 계산 (처음 5개 S&P500 티커)
  const sp500tickers = (universeStats ?? [])
    .filter((r) => r.market === 'US' && (r.index_membership === 'S&P500' || r.index_membership === 'NASDAQ100'))
    .slice(0, 5)
    .map((r: { market: string; index_membership: string | null } & Record<string, unknown>) => (r as unknown as { ticker: string }).ticker)

  const sampleDrawdowns: Record<string, unknown>[] = []
  for (const ticker of sp500tickers) {
    const { data: rows } = await supabase
      .from('stock_price_history')
      .select('date, close')
      .eq('market', 'US')
      .eq('ticker', ticker)
      .gte('date', cutoffStr)
      .order('date', { ascending: true })
    if (rows && rows.length > 0) {
      const closes = rows.map((r) => r.close as number)
      const high3y = Math.max(...closes)
      const currentClose = closes[closes.length - 1]
      const drawdown = ((high3y - currentClose) / high3y) * 100
      sampleDrawdowns.push({ ticker, rowCount: rows.length, high3y, currentClose, drawdown: drawdown.toFixed(1) })
    } else {
      sampleDrawdowns.push({ ticker, rowCount: 0, error: 'no rows' })
    }
  }

  const universeSummary = (universeStats ?? []).reduce(
    (acc: Record<string, Record<string, number>>, r) => {
      const market = r.market ?? 'null'
      const mem = r.index_membership ?? 'null'
      acc[market] ??= {}
      acc[market][mem] = (acc[market][mem] ?? 0) + 1
      return acc
    },
    {},
  )

  return Response.json({
    cutoffDate: cutoffStr,
    universeErrors: uErr?.message,
    universeSummary,
    histCount,
    histCount3y,
    histErrors: hErr?.message ?? h3Err?.message,
    sampleDrawdowns,
  })
}
