import { timingSafeEqual } from 'node:crypto'
import { connection } from 'next/server'

// 국토부 실거래 API(apis.data.go.kr) 중계 — 부동산 수집기(GitHub Actions)가 이 주소를 거쳐 부른다.
//
// 왜: GitHub 실행 서버는 실행마다 IP가 바뀌는데, 그중 일부(2026-09-29 실측 11개 중 2개)는 국토부가
// 연결 자체를 받아주지 않아 `connect timeout`으로 수집이 통째로 실패했다. 같은 순간 DART·네이버는
// 다 붙었으니 길 전체가 아니라 그 IP만 막힌 것이다. 서울 리전의 Vercel 함수는 13번 중 13번 붙었고
// (IP가 두 종류 나왔는데 둘 다 통과), 국내망이라 해외 IP 필터에 걸릴 이유도 적다.
// 이 함수가 서울에서 도는 건 frontend/vercel.json의 regions로 정한다 — 라우트별로는 못 정한다.
//
// 인증: Authorization: Bearer <REVALIDATE_TOKEN> (revalidate 웹훅과 같은 값). 없으면 누구나 우리
// 서버를 통해 국토부를 부를 수 있게 되므로 반드시 잠근다.
// API 키는 주소가 아니라 헤더(x-molit-service-key)로 받는다 — 주소의 쿼리는 Vercel 요청 로그에 남는다.

const UPSTREAM = 'https://apis.data.go.kr/1613000'
// 수집기가 실제로 부르는 세 엔드포인트만 통과시킨다(realestate.py의 _TRADE_URLS·_RENT_URLS).
const ALLOWED_PATHS = new Set([
  '/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev',
  '/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade',
  '/RTMSDataSvcAptRent/getRTMSDataSvcAptRent',
])
const FORWARDED_PARAMS = ['LAWD_CD', 'DEAL_YMD', 'numOfRows', 'pageNo']
// 수집기 쪽 타임아웃(20초)보다 짧게 잡아, 국토부가 느릴 때 우리가 먼저 504로 알려준다.
const UPSTREAM_TIMEOUT_MS = 15000

export const maxDuration = 30

function authorized(request: Request, token: string): boolean {
  const given = Buffer.from(request.headers.get('authorization') ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export async function GET(request: Request) {
  // 요청마다 실행돼야 한다 — 빌드 때 굳으면 중계가 아니다.
  await connection()

  const token = process.env.REVALIDATE_TOKEN
  if (!token) {
    return Response.json({ error: 'REVALIDATE_TOKEN 환경변수가 설정되지 않았습니다.' }, { status: 500 })
  }
  if (!authorized(request, token)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const incoming = new URL(request.url)
  const path = incoming.searchParams.get('path')
  if (!path || !ALLOWED_PATHS.has(path)) {
    return Response.json({ error: '허용되지 않은 path' }, { status: 400 })
  }
  const serviceKey = request.headers.get('x-molit-service-key')
  if (!serviceKey) {
    return Response.json({ error: 'x-molit-service-key 헤더가 없습니다.' }, { status: 400 })
  }

  const target = new URL(`${UPSTREAM}${path}`)
  for (const name of FORWARDED_PARAMS) {
    const value = incoming.searchParams.get(name)
    if (value !== null) target.searchParams.set(name, value)
  }
  // 수집기는 디코딩된 원본 키를 보낸다(normalize_service_key). 여기서 한 번만 인코딩된다.
  target.searchParams.set('serviceKey', serviceKey)

  try {
    const upstream = await fetch(target, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; stock-screener/1.0)' },
      cache: 'no-store',
    })
    // 상태 코드와 본문을 그대로 넘긴다 — 수집기가 403 본문의 사유("서비스 이용 불가" 등)로
    // 신청 문제인지 키 문제인지 가른다. 여기서 해석하거나 다듬지 않는다.
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    return Response.json(
      { error: timedOut ? '국토부 응답 시간 초과' : `국토부 호출 실패: ${e instanceof Error ? e.message : String(e)}` },
      { status: timedOut ? 504 : 502 },
    )
  }
}
