import type { RealestateMediaRow } from '@/lib/types'

interface RealestateMediaSectionProps {
  media: RealestateMediaRow[]
}

function formatRelativeDate(iso: string | null): string {
  if (!iso) return ''
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  if (diffHours < 1) return '방금 전'
  if (diffHours < 24) return `${diffHours}시간 전`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}일 전`
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })
}

/** 부동산 탭 홈 상단 — 관련 뉴스·유튜브 링크. 데이터가 없으면(API 키 미설정 등)
 * 섹션 자체를 숨긴다 — 빈 카드를 보여줄 이유가 없다. */
export function RealestateMediaSection({ media }: RealestateMediaSectionProps) {
  const news = media.filter((m) => m.media_type === 'news').slice(0, 8)
  const videos = media.filter((m) => m.media_type === 'video').slice(0, 6)

  if (news.length === 0 && videos.length === 0) return null

  return (
    <section className="rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
      <h2 className="mb-4 text-base font-bold text-foreground">요즘 부동산 이슈</h2>
      <div className="grid gap-5 md:grid-cols-2">
        {news.length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-semibold text-muted-foreground">관련 기사</h3>
            <ul className="space-y-2.5">
              {news.map((item) => (
                <li key={item.url}>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-sm text-foreground hover:text-primary hover:underline"
                  >
                    {item.title}
                  </a>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {item.source} · {formatRelativeDate(item.published_at)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {videos.length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-semibold text-muted-foreground">관련 영상</h3>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-2">
              {videos.map((item) => (
                <li key={item.url}>
                  <a href={item.url} target="_blank" rel="noopener noreferrer" className="group block">
                    {item.thumbnail_url && (
                      // eslint-disable-next-line @next/next/no-img-element -- 외부(유튜브) 썸네일이라 next/image 도메인 등록 없이 그대로 표시
                      <img
                        src={item.thumbnail_url}
                        alt=""
                        className="aspect-video w-full rounded-md object-cover"
                      />
                    )}
                    <p className="mt-1 line-clamp-2 text-xs text-foreground group-hover:text-primary">
                      {item.title}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{item.source}</p>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
