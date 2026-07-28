import type { NextRequest } from 'next/server'
import { cacheLife } from 'next/cache'
import YahooFinance from 'yahoo-finance2'
const yahooFinance = new YahooFinance()

const KIS_BASE = 'https://openapi.koreainvestment.com:9443'

// KIS 접근토큰은 24시간 유효한데, 모듈 변수 캐시는 서버리스 인스턴스가 새로 뜰 때마다
// (콜드 스타트) 사라져 방문마다 재발급되는 일이 잦았다. 'use cache'는 인스턴스 간
// 공유되는 데이터 캐시에 저장되므로 재발급이 시간당 1회 수준으로 줄어든다.
// 실패 시 throw해 실패 결과가 캐시에 남지 않게 한다 (다음 호출이 재시도).
async function issueKisToken(): Promise<string> {
  'use cache'
  cacheLife('hours')
  const appKey = process.env.KIS_APP_KEY
  const appSecret = process.env.KIS_APP_SECRET
  if (!appKey || !appSecret) throw new Error('KIS credentials not configured')

  const res = await fetch(`${KIS_BASE}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
  })
  if (!res.ok) throw new Error(`KIS token request failed: ${res.status}`)
  const data = (await res.json()) as { access_token?: string }
  if (!data.access_token) throw new Error('KIS token response missing access_token')
  return data.access_token
}

async function getKisAccessToken(): Promise<string | null> {
  try {
    return await issueKisToken()
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
