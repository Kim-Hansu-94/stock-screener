import { describe, expect, it } from 'vitest'
import { parseNaverItems, parseRssItems, publisherFromUrl, stripMarkup, toIsoDate } from './news'

describe('stripMarkup', () => {
  it('네이버 제목의 강조 태그와 엔티티를 걷어낸다', () => {
    expect(stripMarkup('<b>SK하이닉스</b>, &quot;HBM4&quot; 양산 &amp; 공급'))
      .toBe('SK하이닉스, "HBM4" 양산 & 공급')
  })
})

describe('publisherFromUrl', () => {
  it('서브도메인이 붙어도 매체 이름을 찾는다', () => {
    expect(publisherFromUrl('https://news.mt.co.kr/mtview.php?no=1')).toBe('머니투데이')
    expect(publisherFromUrl('https://biz.chosun.com/article/1')).toBe('조선비즈')
  })

  it('모르는 매체는 도메인을 그대로 쓴다', () => {
    expect(publisherFromUrl('https://www.example.co.kr/a')).toBe('example.co.kr')
  })

  it('링크가 깨져도 터지지 않는다', () => {
    expect(publisherFromUrl('not-a-url')).toBe('뉴스')
  })
})

describe('toIsoDate', () => {
  it('네이버의 RFC 1123 형식을 ISO로 바꾼다', () => {
    expect(toIsoDate('Tue, 19 Aug 2026 14:30:00 +0900')).toBe('2026-08-19T05:30:00.000Z')
  })

  it('날짜가 없거나 이상하면 현재 시각으로 대체한다(빈 문자열이 화면에 뜨지 않게)', () => {
    expect(() => new Date(toIsoDate('쓰레기값')).toISOString()).not.toThrow()
  })
})

describe('parseNaverItems', () => {
  it('원문 링크로 매체를 표시하고, 읽기 링크는 네이버 쪽을 쓴다', () => {
    const [item] = parseNaverItems([
      {
        title: '<b>SK하이닉스</b> 실적 발표',
        link: 'https://n.news.naver.com/article/001/123',
        originallink: 'https://www.yna.co.kr/view/123',
        pubDate: 'Tue, 19 Aug 2026 14:30:00 +0900',
      },
    ])
    expect(item.title).toBe('SK하이닉스 실적 발표')
    expect(item.url).toBe('https://n.news.naver.com/article/001/123')
    expect(item.publisher).toBe('연합뉴스')
  })

  it('제목이나 링크가 빈 항목은 버린다', () => {
    expect(parseNaverItems([{ title: '제목만 있음' }, { link: 'https://a.com' }])).toEqual([])
  })
})

describe('parseRssItems', () => {
  const xml = `<rss><channel>
    <item>
      <title>SK하이닉스 &amp; HBM</title>
      <link>https://news.google.com/articles/abc</link>
      <pubDate>Tue, 19 Aug 2026 14:30:00 GMT</pubDate>
      <source url="https://www.hankyung.com">한국경제</source>
    </item>
    <item>
      <title>링크 없는 기사</title>
    </item>
  </channel></rss>`

  it('링크가 없는 항목은 건너뛴다', () => {
    const items = parseRssItems(xml)
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('SK하이닉스 & HBM')
    expect(items[0].publisher).toBe('한국경제')
    expect(items[0].publishedAt).toBe('2026-08-19T14:30:00.000Z')
  })
})
