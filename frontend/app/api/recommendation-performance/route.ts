import { createServerSupabaseClient } from '@/lib/supabase'
import type {
  RecommendationPerformanceDate,
  RecommendationPerformanceResponse,
  RecommendationPerformanceStock,
} from '@/lib/types'

interface RecHistoryRow {
  ticker: string
  name: string
  sector: string | null
  entry_price: number | null
  recommended_date: string
  rank: number
}

interface PriceRow {
  ticker: string
  date: string
  close: number
}

export async function GET() {
  const supabase = createServerSupabaseClient()

  // 최근 14일 추천 기록 조회 (주말 포함 3 거래일 커버)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 14)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)

  const { data: recData, error: recError } = await supabase
    .from('recommendation_history')
    .select('ticker, name, sector, entry_price, recommended_date, rank')
    .gte('recommended_date', cutoffStr)
    .order('recommended_date', { ascending: false })
    .order('rank', { ascending: true })

  if (recError) return Response.json({ error: recError.message }, { status: 500 })
  if (!recData || recData.length === 0) {
    return Response.json({ dates: [] } satisfies RecommendationPerformanceResponse)
  }

  const rows = recData as RecHistoryRow[]
  const tickers = [...new Set(rows.map((r) => r.ticker))]

  // 추천일 이후 종가 조회
  const { data: priceData, error: priceError } = await supabase
    .from('stock_price_history')
    .select('ticker, date, close')
    .in('ticker', tickers)
    .gte('date', cutoffStr)
    .lte('date', today)
    .eq('market', 'US')
    .order('date', { ascending: true })

  if (priceError) return Response.json({ error: priceError.message }, { status: 500 })

  // ticker → [{date, close}] 맵
  const priceMap: Record<string, PriceRow[]> = {}
  for (const p of (priceData ?? []) as PriceRow[]) {
    priceMap[p.ticker] ??= []
    priceMap[p.ticker].push(p)
  }

  // 날짜별 그룹
  const byDate: Record<string, RecHistoryRow[]> = {}
  for (const rec of rows) {
    byDate[rec.recommended_date] ??= []
    byDate[rec.recommended_date].push(rec)
  }

  const dates: RecommendationPerformanceDate[] = Object.keys(byDate)
    .sort()
    .reverse()
    .map((date) => {
      const stocks: RecommendationPerformanceStock[] = byDate[date].map((rec) => {
        const futurePrices = (priceMap[rec.ticker] ?? [])
          .filter((p) => p.date > date)
          .slice(0, 3)

        const returns = futurePrices.map((p, i) => ({
          day: i + 1,
          date: p.date,
          closePrice: p.close,
          returnPct:
            rec.entry_price && rec.entry_price > 0
              ? ((p.close - rec.entry_price) / rec.entry_price) * 100
              : null,
        }))

        return {
          ticker: rec.ticker,
          name: rec.name,
          sector: rec.sector,
          entryPrice: rec.entry_price,
          rank: rec.rank,
          returns,
        }
      })

      return { date, stocks }
    })

  return Response.json({ dates } satisfies RecommendationPerformanceResponse)
}
