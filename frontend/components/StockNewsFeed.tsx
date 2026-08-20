'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { formatRelativeTime } from '@/lib/calculations'
import type { NewsArticle } from '@/lib/types'

/** 자동 갱신 주기 — 서버 라우트의 재검증 주기(1시간)와 같게 둔다. 더 자주 불러도 같은 응답만 받는다. */
const REFRESH_MS = 3_600_000

interface FeedState {
  /** 이 결과가 어느 종목의 것인지. 종목이 바뀌면 이전 종목 기사를 잠깐이라도 보여주지 않기 위해 함께 들고 있는다. */
  query: string
  news: NewsArticle[] | null
  failed: boolean
}

// 감시 종목 카드에 상시 노출되는 뉴스 목록. 펼쳐야 보이는 StockCard의 뉴스와 달리
// 화면에 계속 떠 있고, 페이지를 켜 둔 채로도 1시간마다 스스로 최신 기사로 바뀐다.
export function StockNewsFeed({ query, className = '' }: { query: string; className?: string }) {
  const [state, setState] = useState<FeedState>({ query, news: null, failed: false })
  // 백그라운드 탭에서는 타이머가 밀리므로, 탭으로 돌아왔을 때 얼마나 묵었는지 직접 잰다.
  const fetchedAt = useRef(0)

  const load = useCallback(async () => {
    fetchedAt.current = Date.now()
    try {
      // no-store: 브라우저 캐시를 건너뛰어야 1시간마다 실제로 새 응답을 받는다.
      // 구글 RSS 호출 자체는 라우트 쪽 revalidate가 막아주므로 부담이 늘지 않는다.
      const res = await fetch(`/api/stock-news?q=${encodeURIComponent(query)}`, { cache: 'no-store' })
      // 라우트는 실패해도 JSON({error})을 주므로, 상태 코드를 안 보면 장애가 '기사 0건'으로 보인다.
      if (!res.ok) throw new Error(`stock-news ${res.status}`)
      const data: { news?: NewsArticle[] } = await res.json()
      setState({ query, news: data.news ?? [], failed: false })
    } catch {
      // 갱신 실패 시 직전 목록을 지우지 않는다 — 빈 화면보다 조금 묵은 기사가 낫다.
      setState((prev) => (prev.query === query ? { ...prev, failed: true } : { query, news: null, failed: true }))
    }
  }, [query])

  useEffect(() => {
    // load()의 setState는 await 뒤에 일어나므로 동기 연쇄 렌더가 아니다(규칙이 async 경계를 못 본다).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    const timer = setInterval(load, REFRESH_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - fetchedAt.current >= REFRESH_MS) load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  const fresh = state.query === query
  const news = fresh ? state.news : null
  const failed = fresh && state.failed

  return (
    <div className={className}>
      <p className="mb-2 text-xs font-semibold text-muted-foreground">
        최신 뉴스 <span className="font-normal text-muted-foreground/70">· 1시간마다 갱신</span>
      </p>
      {news === null && !failed && <p className="text-xs text-muted-foreground">뉴스 불러오는 중...</p>}
      {news === null && failed && <p className="text-xs text-muted-foreground">뉴스를 불러오지 못했습니다.</p>}
      {news !== null && news.length === 0 && (
        <p className="text-xs text-muted-foreground">최근 기사가 없습니다.</p>
      )}
      {news !== null && news.length > 0 && (
        <ul className="space-y-2.5">
          {news.map((article) => (
            <li key={article.url}>
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-sm leading-snug font-medium break-keep hover:text-primary"
              >
                {article.title}
              </a>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {article.publisher} · {formatRelativeTime(article.publishedAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
