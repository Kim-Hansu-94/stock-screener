import { NextRequest } from 'next/server'
import { getBuyback, getConsensus, getInvestorFlow } from '@/lib/queries/krExtras'

/**
 * 국내 부가 데이터 3종(수급·컨센서스·자사주)을 종목 단위로 내려주는 라우트.
 *
 * 카드를 펼쳤을 때만 부른다 — /api/price-history와 같은 이유다. 세 표를 화면
 * 렌더에 미리 실으면 종목 수만큼 곱해져 다시 페이로드가 불어난다.
 *
 * 미국 종목은 대상이 아니다. 셋 다 국내 시장 개념이고(외국인·기관 수급 구분,
 * 증권사 컨센서스, 자기주식 공시), 소스도 네이버·DART라 미장 값이 없다.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const market = params.get('market')
  const ticker = (params.get('ticker') ?? '').trim()

  if (!ticker) return Response.json({ error: 'ticker가 필요합니다.' }, { status: 400 })
  if (market !== 'KR') {
    // 오류가 아니라 "해당 없음"이다 — 화면은 이 응답을 받으면 섹션을 숨긴다.
    return Response.json({ flow: [], consensus: null, buyback: null, unsupported: true })
  }

  const [flow, consensus, buyback] = await Promise.all([
    getInvestorFlow(ticker),
    getConsensus(ticker),
    getBuyback(ticker),
  ])
  return Response.json({ flow, consensus, buyback })
}
