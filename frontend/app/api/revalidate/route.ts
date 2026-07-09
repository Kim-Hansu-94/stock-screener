import { revalidateTag } from 'next/cache'
import { SCREENER_CACHE_TAG } from '@/lib/queries'

// 파이프라인(GitHub Actions)이 DB 갱신을 마친 직후 호출하는 웹훅.
// 사이트의 모든 캐시 쿼리가 같은 태그를 공유하므로, 이 한 번의 호출로
// 전 페이지가 동일한 시점의 새 데이터로 함께 갱신된다.
// 인증: Authorization: Bearer <REVALIDATE_TOKEN> (Vercel 환경변수와
// GitHub Actions 시크릿에 같은 값을 등록해야 한다.)
export async function POST(request: Request) {
  const token = process.env.REVALIDATE_TOKEN
  if (!token) {
    return Response.json(
      { error: 'REVALIDATE_TOKEN 환경변수가 설정되지 않았습니다.' },
      { status: 500 },
    )
  }

  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${token}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  // 웹훅 경로이므로 즉시 만료({ expire: 0 })로 다음 요청부터 새 데이터를 읽게 한다.
  revalidateTag(SCREENER_CACHE_TAG, { expire: 0 })
  return Response.json({ revalidated: true, at: new Date().toISOString() })
}
