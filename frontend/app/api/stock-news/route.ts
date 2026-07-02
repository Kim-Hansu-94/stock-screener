import { NextRequest } from 'next/server'

interface YahooNewsItem {
  uuid: string
  title: string
  publisher: string
  link: string
  providerPublishTime: number
  type: string
}

interface YahooSearchResponse {
  news?: YahooNewsItem[]
}

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get('ticker')
  if (!ticker || !/^[A-Z]{1,6}(-[A-Z])?$/.test(ticker)) {
    return Response.json({ error: '유효하지 않은 티커' }, { status: 400 })
  }

  const url =
    `https://query1.finance.yahoo.com/v1/finance/search` +
    `?q=${ticker}&newsCount=5&enableFuzzyQuery=false&enableCb=false` +
    `&enableNavLinks=false&enableEnhancedTrivialQuery=true`

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      },
      next: { revalidate: 3600 },
    })
    if (!resp.ok) throw new Error(`Yahoo Finance ${resp.status}`)

    const data: YahooSearchResponse = await resp.json()
    const news = (data.news ?? [])
      .filter((n) => n.type === 'STORY')
      .slice(0, 3)
      .map((n) => ({
        title: n.title,
        publisher: n.publisher,
        url: n.link,
        publishedAt: new Date(n.providerPublishTime * 1000).toISOString(),
      }))

    return Response.json(
      { ticker, news },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' } },
    )
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
