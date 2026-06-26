import type { NextRequest } from 'next/server'
import yahooFinance from 'yahoo-finance2'
import { createServerSupabaseClient } from '@/lib/supabase'
import type { PriceHistoryRow, SimilarStockResult } from '@/lib/types'

const TOP_N = 20
const MIN_OVERLAP_DAYS = 20

function normalizeToReturns(prices: number[]): number[] {
  const returns: number[] = []
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1])
  }
  if (returns.length === 0) return []
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length
  const std = Math.sqrt(variance)
  return std < 0.001 ? returns.map(() => 0) : returns.map((r) => (r - mean) / std)
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  if (len < MIN_OVERLAP_DAYS) return 0
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    magA += a[i] ** 2
    magB += b[i] ** 2
  }
  if (magA === 0 || magB === 0) return 0
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const ticker = searchParams.get('ticker')
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  if (!ticker || !from || !to) {
    return Response.json({ error: 'ticker, from, to 파라미터가 필요합니다.' }, { status: 400 })
  }

  // 1. Fetch reference ticker historical data from Yahoo Finance
  let refPrices: number[]
  try {
    const hist = (await yahooFinance.historical(
      ticker,
      { period1: from, period2: to },
      { validateResult: false },
    )) as unknown as Array<{ close: number }>
    refPrices = hist.map((d) => d.close).filter((v) => v != null && isFinite(v))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `${ticker} 데이터 오류: ${msg}` }, { status: 502 })
  }

  if (refPrices.length < MIN_OVERLAP_DAYS) {
    return Response.json(
      { error: `기간이 너무 짧습니다. 최소 ${MIN_OVERLAP_DAYS}거래일 이상 선택하세요.` },
      { status: 400 },
    )
  }
  const refNorm = normalizeToReturns(refPrices)
  const windowLen = refNorm.length

  // 2. Fetch all US universe price history from Supabase
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 120)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const supabase = createServerSupabaseClient()
  const { data: universeData, error: universeErr } = await supabase
    .from('stock_universe')
    .select('ticker, name, sector')
    .eq('market', 'US')
  if (universeErr) return Response.json({ error: universeErr.message }, { status: 500 })

  const universeMap = new Map<string, { name: string; sector: string | null }>(
    (universeData ?? []).map((r) => [r.ticker, { name: r.name, sector: r.sector }]),
  )

  const { data: histData, error: histErr } = await supabase
    .from('stock_price_history')
    .select('ticker, date, close, open, high, low, volume, market')
    .eq('market', 'US')
    .gte('date', cutoffStr)
    .order('date', { ascending: true })
  if (histErr) return Response.json({ error: histErr.message }, { status: 500 })

  // Group by ticker
  const grouped: Record<string, PriceHistoryRow[]> = {}
  for (const row of (histData ?? []) as PriceHistoryRow[]) {
    grouped[row.ticker] ??= []
    grouped[row.ticker].push(row)
  }

  // 3. Compute cosine similarity for each stock using last windowLen days
  const results: SimilarStockResult[] = []
  for (const [t, rows] of Object.entries(grouped)) {
    if (t === ticker.toUpperCase()) continue
    const prices = rows.map((r) => r.close)
    // Compare the most recent windowLen prices
    const slice = prices.slice(-windowLen)
    const norm = normalizeToReturns(slice)
    const sim = cosineSimilarity(refNorm, norm)
    if (sim <= 0) continue

    const meta = universeMap.get(t)
    results.push({
      ticker: t,
      name: meta?.name ?? t,
      sector: meta?.sector ?? null,
      similarity: sim,
      history: rows,
    })
  }

  results.sort((a, b) => b.similarity - a.similarity)
  return Response.json(results.slice(0, TOP_N))
}
