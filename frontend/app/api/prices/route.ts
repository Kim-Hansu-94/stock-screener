import type { NextRequest } from 'next/server'
import YahooFinance from 'yahoo-finance2'
const yahooFinance = new YahooFinance()

const KIS_BASE = 'https://openapi.koreainvestment.com:9443'

// Module-level token cache (persists within a serverless function instance)
let kisToken: { value: string; expiresAt: number } | null = null

async function getKisAccessToken(): Promise<string | null> {
  if (kisToken && kisToken.expiresAt > Date.now() + 60_000) {
    return kisToken.value
  }
  const appKey = process.env.KIS_APP_KEY
  const appSecret = process.env.KIS_APP_SECRET
  if (!appKey || !appSecret) return null

  try {
    const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { access_token?: string }
    const token = data.access_token
    if (!token) return null
    kisToken = { value: token, expiresAt: Date.now() + 23 * 3_600_000 }
    return token
  } catch {
    return null
  }
}

async function fetchKisPrice(ticker: string): Promise<number | null> {
  const token = await getKisAccessToken()
  if (!token) return null
  const appKey = process.env.KIS_APP_KEY!
  const appSecret = process.env.KIS_APP_SECRET!

  try {
    const res = await fetch(
      `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${ticker}`,
      {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${token}`,
          appkey: appKey,
          appsecret: appSecret,
          tr_id: 'FHKST01010100',
          custtype: 'P',
        },
        next: { revalidate: 60 },
      },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { output?: { stck_prpr?: string } }
    const priceStr = data.output?.stck_prpr
    if (!priceStr || priceStr === '0') return null
    return parseInt(priceStr, 10)
  } catch {
    return null
  }
}

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
  // KR: KIS API 우선, 실패 시 Yahoo Finance 폴백
  const kisPrice = await fetchKisPrice(ticker)
  if (kisPrice !== null) return kisPrice
  const ks = await fetchYahooPrice(`${ticker}.KS`)
  if (ks !== null) return ks
  return fetchYahooPrice(`${ticker}.KQ`)
}

async function fetchYahooPrice(symbol: string): Promise<number | null> {
  try {
    const quote = (await yahooFinance.quote(symbol)) as unknown as { regularMarketPrice?: number }
    return quote.regularMarketPrice ?? null
  } catch {
    return null
  }
}
