import { NextRequest } from 'next/server'
import { parseNaverItems, parseRssItems, type NaverNewsItem, type ParsedNewsItem } from '@/lib/news'

// 카드에 한 번에 보여줄 기사 수. 감시 종목 카드는 이 개수를 그대로 노출한다.
const NEWS_LIMIT = 5

// 뉴스 재검증 주기 — 프론트의 자동 갱신 주기(1시간)와 같게 둔다.
const REVALIDATE_SEC = 3600

/**
 * 네이버 뉴스 검색 API. 키가 없으면 null을 돌려주고 호출부가 구글로 넘어간다.
 *
 * 네이버는 뉴스 검색 RSS를 제공하지 않아 개발자센터에서 발급한 Client ID/Secret이 필요하다
 * (NAVER_CLIENT_ID / NAVER_CLIENT_SECRET). 미설정이어도 화면은 구글 뉴스로 그대로 돈다.
 */
async function fetchNaverNews(query: string): Promise<ParsedNewsItem[] | null> {
  const clientId = process.env.NAVER_CLIENT_ID
  const clientSecret = process.env.NAVER_CLIENT_SECRET
  if (!clientId || !clientSecret) return null

  // sort=date: 최신순. 정확도순(sim)으로 받으면 몇 달 전 기사가 섞여 "최신 뉴스"가 아니게 된다.
  const url =
    `https://openapi.naver.com/v1/search/news.json` +
    `?query=${encodeURIComponent(query)}&display=${NEWS_LIMIT}&sort=date`

  const resp = await fetch(url, {
    headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret },
    next: { revalidate: REVALIDATE_SEC },
  })
  if (!resp.ok) throw new Error(`Naver News ${resp.status}`)

  const data: { items?: NaverNewsItem[] } = await resp.json()
  return parseNaverItems(data.items ?? [])
}

async function fetchGoogleNews(query: string): Promise<ParsedNewsItem[]> {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`
  const resp = await fetch(rssUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      Accept: 'application/rss+xml, application/xml, text/xml, */*',
    },
    next: { revalidate: REVALIDATE_SEC },
  })
  if (!resp.ok) throw new Error(`Google News RSS ${resp.status}`)

  return parseRssItems(await resp.text())
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

  // 국내 종목(한글 검색어)은 네이버가 훨씬 촘촘하다. 미장 티커는 한글 기사가 드물어
  // 구글(ko-KR)이 낫고, 키가 없거나 네이버가 실패하면 어느 쪽이든 구글로 내려간다.
  const preferNaver = /[가-힣]/.test(searchQuery)
  let news: ParsedNewsItem[] | null = null
  let source: 'naver' | 'google' = 'google'

  if (preferNaver) {
    try {
      const naver = await fetchNaverNews(searchQuery)
      if (naver && naver.length > 0) {
        news = naver
        source = 'naver'
      }
    } catch {
      // 네이버 장애·쿼터 초과(하루 25,000건)면 조용히 구글로 내려간다.
    }
  }

  try {
    if (news === null) news = await fetchGoogleNews(searchQuery)
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }

  return Response.json(
    { ticker, source, news: news.slice(0, NEWS_LIMIT) },
    { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' } },
  )
}
