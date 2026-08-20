// 뉴스 응답 파싱 — 네트워크를 타는 부분(app/api/stock-news/route.ts)과 분리해 테스트한다.
// 라우트 파일은 핸들러 외 export가 금지돼 있어 순수 함수만 여기로 뺐다.

export interface ParsedNewsItem {
  title: string
  url: string
  publisher: string
  publishedAt: string
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
}

/** 네이버 API 제목에는 검색어 강조 태그(<b>)와 HTML 엔티티가 섞여 온다. */
export function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&nbsp;/g, (m) => HTML_ENTITIES[m] ?? m)
    .trim()
}

// 도메인만 보여주면 "n.news.naver.com" 같은 게 뜨므로, 자주 나오는 매체는 이름으로 바꾼다.
const PUBLISHER_BY_HOST: Record<string, string> = {
  'n.news.naver.com': '네이버뉴스',
  'news.naver.com': '네이버뉴스',
  'yna.co.kr': '연합뉴스',
  'hankyung.com': '한국경제',
  'mk.co.kr': '매일경제',
  'sedaily.com': '서울경제',
  'mt.co.kr': '머니투데이',
  'edaily.co.kr': '이데일리',
  'chosun.com': '조선비즈',
  'fnnews.com': '파이낸셜뉴스',
  'zdnet.co.kr': 'ZDNet코리아',
  'etnews.com': '전자신문',
  'newsis.com': '뉴시스',
  'inews24.com': '아이뉴스24',
}

export function publisherFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname
    // news.mt.co.kr / biz.chosun.com처럼 서브도메인이 붙어 오므로 뒤에서부터 맞춰본다.
    const parts = host.split('.')
    for (let i = 0; i < parts.length - 1; i += 1) {
      const candidate = parts.slice(i).join('.')
      const name = PUBLISHER_BY_HOST[candidate]
      if (name) return name
    }
    return host.replace(/^www\./, '')
  } catch {
    return '뉴스'
  }
}

export function toIsoDate(raw: string): string {
  const parsed = raw ? new Date(raw) : new Date()
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString()
}

/** 구글 뉴스 RSS(XML) → 기사 목록 */
export function parseRssItems(xml: string): ParsedNewsItem[] {
  const items: ParsedNewsItem[] = []
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const content = match[1]

    const titleRaw = content.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]?.trim()
    if (!titleRaw) continue

    const url = content.match(/<link>\s*(https?:\/\/[^\s<]+)\s*<\/link>/)?.[1]?.trim() ?? ''
    if (!url) continue

    const pubDate = content.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? ''
    const source = content.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]?.trim()

    items.push({
      title: stripMarkup(titleRaw),
      url,
      publisher: source || '구글뉴스',
      publishedAt: toIsoDate(pubDate),
    })
  }
  return items
}

export interface NaverNewsItem {
  title?: string
  link?: string
  originallink?: string
  pubDate?: string
}

/** 네이버 뉴스 검색 API 응답 → 기사 목록 */
export function parseNaverItems(items: NaverNewsItem[]): ParsedNewsItem[] {
  return items
    .map((item) => {
      // link는 보통 네이버 뉴스 페이지(모바일에서 읽기 편함), 없으면 원문 매체로.
      const link = item.link || item.originallink || ''
      return {
        title: stripMarkup(item.title ?? ''),
        url: link,
        // 출처 이름은 원문 링크에서 뽑는다 — 네이버 링크만 보면 전부 "네이버뉴스"가 된다.
        publisher: publisherFromUrl(item.originallink || link),
        publishedAt: toIsoDate(item.pubDate ?? ''),
      }
    })
    .filter((item) => item.title && item.url)
}
