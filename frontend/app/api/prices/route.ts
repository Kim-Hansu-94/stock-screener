import type { NextRequest } from 'next/server'
import yahooFinance from 'yahoo-finance2'

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const tickersParam = searchParams.get('tickers')
  const market = searchParams.get('market') as 'US' | 'KR' | null

  if (!tickersParam || !market) {
    return Response.json({ error: 'Missing tickers or market' }, { status: 400 })
  }

  const tickers = tickersParam.split(',').filter(Boolean)
  const result: Record<string, number | null> = {}

  await Promise.all(
    tickers.map(async (ticker) => {
      result[ticker] = await fetchPrice(ticker, market)
    }),
  )

  return Response.json(result)
}

async function fetchPrice(ticker: string, market: 'US' | 'KR'): Promise<number | null> {
  if (market === 'US') {
    return fetchYahooPrice(ticker)
  }
  const ks = await fetchYahooPrice(`${ticker}.KS`)
  if (ks !== null) return ks
  return fetchYahooPrice(`${ticker}.KQ`)
}

async function fetchYahooPrice(symbol: string): Promise<number | null> {
  try {
    // yahoo-finance2's generic type resolves to never under some TS configs — cast via unknown
    const quote = (await yahooFinance.quote(symbol)) as unknown as { regularMarketPrice?: number }
    return quote.regularMarketPrice ?? null
  } catch {
    return null
  }
}
