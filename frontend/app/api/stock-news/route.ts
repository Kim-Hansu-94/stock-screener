import { NextRequest } from 'next/server'

interface ParsedNewsItem {
  title: string
  url: string
  publisher: string
  publishedAt: string
}

function parseRssItems(xml: string): ParsedNewsItem[] {
  const items: ParsedNewsItem[] = []
  const matches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g)
  for (const match of matches) {
    const content = match[1]

    const titleRaw = content.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]?.trim()
    if (!titleRaw) continue

    const linkMatch = content.match(/<link>\s*(https?:\/\/[^\s<]+)\s*<\/link>/)
    const url = linkMatch?.[1]?.trim() ?? ''
    if (!url) continue

    const pubDateStr = content.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? ''
    let publishedAt: string
    try {
      publishedAt = pubDateStr ? new Date(pubDateStr).toISOString() : new Date().toISOString()
    } catch {
      publishedAt = new Date().toISOString()
    }

    const sourceMatch = content.match(/<source[^>]*>([\s\S]*?)<\/source>/)
    const publisher = sourceMatch?.[1]?.trim() ?? 'Yahoo Finance'

    items.push({ title: titleRaw, url, publisher, publishedAt })
  }
  return items
}

export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get('ticker')
  const q = req.nextUrl.searchParams.get('q')?.trim()

  let searchQuery: string
  if (q && q.length > 0 && q.length <= 100) {
    searchQuery = q
  } else if (ticker && /^[A-Z]{1,6}(-[A-Z])?$/.test(ticker)) {
    searchQuery = ticker
  } else {
    return Response.json({ error: '유효하지 않은 파라미터' }, { status: 400 })
  }

  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=ko&gl=KR&ceid=KR:ko`

  try {
    const resp = await fetch(rssUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      next: { revalidate: 3600 },
    })
    if (!resp.ok) throw new Error(`Google News RSS ${resp.status}`)

    const xml = await resp.text()
    const news = parseRssItems(xml).slice(0, 3)

    return Response.json(
      { ticker, news },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' } },
    )
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
