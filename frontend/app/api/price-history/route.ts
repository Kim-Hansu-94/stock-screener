import { NextRequest } from 'next/server'
import { getPriceHistoryByTicker } from '@/lib/queries/screener'
import type { Market } from '@/lib/types'

/**
 * 종목 하나의 일봉을 필요할 때만 내려주는 라우트.
 *
 * 예전에는 화면(눌림목·종목발굴)이 표시되는 **모든 종목의 일봉을 미리 다** 받아
 * 클라이언트로 내려보냈다. 차트는 카드를 펼쳐야 뜨는데도 그랬다 — 종목 40개 ×
 * 150봉 × 8개 값이면 RSC 페이로드가 수백 KB로 불어나, 탭을 누를 때마다 그걸
 * 내려받느라 화면 전환이 눈에 띄게 느렸다. 이제 카드를 펼친 종목만 여기로 받는다.
 *
 * 조회 자체는 화면과 같은 getPriceHistoryByTicker를 쓴다('use cache' +
 * SCREENER_CACHE_TAG). 파이프라인이 끝나고 /api/revalidate가 태그를 무효화하면
 * 이 응답도 같이 갱신된다.
 */

// 차트가 그리는 최대 구간. 화면에서 넘어오는 값이 이보다 크면 여기서 자른다.
const MAX_DAYS = 600

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const market = params.get('market')
  const ticker = (params.get('ticker') ?? '').trim().toUpperCase()
  const days = Number(params.get('days') ?? 150)

  if ((market !== 'KR' && market !== 'US') || !ticker) {
    return Response.json({ error: 'market과 ticker가 필요합니다.' }, { status: 400 })
  }

  const clampedDays = Number.isFinite(days) ? Math.min(Math.max(Math.trunc(days), 1), MAX_DAYS) : 150

  try {
    const grouped = await getPriceHistoryByTicker(market as Market, [ticker], clampedDays)
    return Response.json({ history: grouped[ticker] ?? [] })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '일봉을 불러오지 못했습니다.'
    return Response.json({ error: message }, { status: 500 })
  }
}
