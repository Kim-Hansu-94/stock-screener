import { NextRequest } from 'next/server'
import { parseNaverItems, type NaverNewsItem, type ParsedNewsItem } from '@/lib/news'

// 카드에 한 번에 보여줄 기사 수. 감시 종목 카드는 이 개수를 그대로 노출한다.
const NEWS_LIMIT = 5

// 뉴스 재검증 주기 — 프론트의 자동 갱신 주기(1시간)와 같게 둔다.
const REVALIDATE_SEC = 3600

// 네이버 뉴스검색 — 파이프라인의 부동산 뉴스 수집(realestate_media.py)과 **같은
// 엔드포인트·같은 헤더**를 쓴다. 2026-09 기준 구 개발자센터(openapi.naver.com)는
// 신규 발급이 막히고 NAVER API HUB로 이관됐는데, 이 라우트만 옛 주소·옛 헤더에
// 남아 있어서 HUB 키로는 인증이 깨졌고 → 조용히 구글 뉴스로 내려가고 있었다.
// 종목과 무관한 기사가 뜨던 원인이 이것이다(2026-09-09).
const NAVER_NEWS_URL = 'https://naverapihub.apigw.ntruss.com/search/v1/news'

/** 네이버 뉴스 검색 API. 키가 없으면 null(호출부가 "키 미설정"으로 응답한다). */
async function fetchNaverNews(query: string): Promise<ParsedNewsItem[] | null> {
  const clientId = process.env.NAVER_CLIENT_ID
  const clientSecret = process.env.NAVER_CLIENT_SECRET
  if (!clientId || !clientSecret) return null

  // sort=date: 최신순. 정확도순(sim)으로 받으면 몇 달 전 기사가 섞여 "최신 뉴스"가 아니게 된다.
  const url =
    `${NAVER_NEWS_URL}?query=${encodeURIComponent(query)}&display=${NEWS_LIMIT}&sort=date`

  const resp = await fetch(url, {
    headers: {
      'X-NCP-APIGW-API-KEY-ID': clientId,
      'X-NCP-APIGW-API-KEY': clientSecret,
    },
    next: { revalidate: REVALIDATE_SEC },
  })
  if (!resp.ok) throw new Error(`Naver News ${resp.status}`)

  const data: { items?: NaverNewsItem[] } = await resp.json()
  return parseNaverItems(data.items ?? [])
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

  // 검색어가 종목명 그 자체라(카드가 회사명을 그대로 넘김), 다른 분야와 이름이 겹치는
  // 종목은 무관한 기사가 섞여 들어온다 — 한화(한화이글스 야구단), 롯데(롯데자이언츠) 등.
  // "주가"를 붙여 증권 관련 기사로 좁힌다. 미장 티커(NVDA 등)도 마찬가지로 붙인다 —
  // 국내 기사는 보통 "엔비디아(NVDA) 주가..." 형태라 이 조합이 잘 맞고, 안 붙이면
  // 티커와 같은 약어를 쓰는 엉뚱한 기사가 걸린다.
  const effectiveQuery = `${searchQuery} 주가`

  let news: ParsedNewsItem[] | null
  try {
    news = await fetchNaverNews(effectiveQuery)
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 })
  }

  // 키가 없으면 기사 0건이 아니라 사유를 돌려준다 — 조용히 빈 목록을 주면
  // "이 종목은 뉴스가 없구나"로 오해하게 된다.
  if (news === null) {
    return Response.json(
      { ticker, source: 'naver', news: [], error: 'NAVER_CLIENT_ID/SECRET 미설정' },
      { status: 200 },
    )
  }

  return Response.json(
    { ticker, source: 'naver', news: news.slice(0, NEWS_LIMIT) },
    { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=600' } },
  )
}
