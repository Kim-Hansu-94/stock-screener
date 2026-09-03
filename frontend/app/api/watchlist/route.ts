import { revalidateTag } from 'next/cache'
import { createServerSupabaseClient } from '@/lib/supabase'
import { SCREENER_CACHE_TAG } from '@/lib/queries/shared'
import { checkTradePin } from '@/lib/tradeAuth'
import type { Market } from '@/lib/types'

/**
 * 감시 종목(watchlist_tickers) 추가/삭제. 조회는 서버 컴포넌트가 직접 하고,
 * 여기서는 쓰기만 받는다 — /api/trades와 동일한 구조.
 *
 * 파이프라인(watchlist.py)이 다음 실행(아침/저녁)에 이 테이블을 읽어 평가하므로,
 * 추가 직후에는 watchlist_status가 아직 없다 — 화면에서 "평가 대기"로 표시한다.
 */

// 파이프라인 1회 실행 시간이 과도하게 늘어나지 않도록 거는 안전장치.
const MAX_WATCHLIST_SIZE = 30

function parseMarket(value: unknown): Market | null {
  return value === 'KR' || value === 'US' ? value : null
}

export async function POST(request: Request) {
  const pin = checkTradePin(request)
  if (!pin.ok) return Response.json({ error: pin.error }, { status: pin.status })

  let body: { market?: string; ticker?: string; name?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 })
  }

  const market = parseMarket(body.market)
  const ticker = typeof body.ticker === 'string' ? body.ticker.trim().toUpperCase() : ''
  if (!market || !ticker) {
    return Response.json({ error: 'market과 ticker가 필요합니다.' }, { status: 400 })
  }

  const supabase = createServerSupabaseClient()

  const { count } = await supabase
    .from('watchlist_tickers')
    .select('ticker', { count: 'exact', head: true })
  if ((count ?? 0) >= MAX_WATCHLIST_SIZE) {
    return Response.json(
      { error: `감시 종목은 최대 ${MAX_WATCHLIST_SIZE}개까지 추가할 수 있습니다.` },
      { status: 422 },
    )
  }

  // 가격 데이터가 없으면 파이프라인이 평가할 수 없다 — 미리 걸러서 알려준다
  // (상장 안 된 종목·티커 오타를 여기서 잡아준다).
  const { data: priceRow } = await supabase
    .from('stock_price_history')
    .select('date')
    .eq('market', market)
    .eq('ticker', ticker)
    .limit(1)
    .maybeSingle()
  if (!priceRow) {
    return Response.json(
      {
        error:
          '이 종목의 가격 데이터가 없어 감시 목록에 추가할 수 없습니다. 티커를 확인하거나, 상장되지 않은(비상장) 종목은 아닌지 확인해 주세요.',
      },
      { status: 422 },
    )
  }

  let name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    const { data: uni } = await supabase
      .from('stock_universe')
      .select('name, name_kr')
      .eq('market', market)
      .eq('ticker', ticker)
      .maybeSingle()
    name = (market === 'KR' ? uni?.name_kr || uni?.name : uni?.name) || ticker
  }

  const { error } = await supabase
    .from('watchlist_tickers')
    .insert({ market, ticker, name: name.slice(0, 200) })

  if (error) {
    if (error.code === '23505') {
      return Response.json({ error: '이미 감시 목록에 있는 종목입니다.' }, { status: 409 })
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  revalidateTag(SCREENER_CACHE_TAG, { expire: 0 })
  return Response.json({ market, ticker, name })
}

export async function DELETE(request: Request) {
  const pin = checkTradePin(request)
  if (!pin.ok) return Response.json({ error: pin.error }, { status: pin.status })

  let body: { market?: string; ticker?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 })
  }

  const market = parseMarket(body.market)
  const ticker = typeof body.ticker === 'string' ? body.ticker.trim().toUpperCase() : ''
  if (!market || !ticker) {
    return Response.json({ error: 'market과 ticker가 필요합니다.' }, { status: 400 })
  }

  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('watchlist_tickers')
    .delete()
    .eq('market', market)
    .eq('ticker', ticker)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  // watchlist_status는 다음 파이프라인 실행에서 정리되지만(prune_watchlist_status),
  // 그 전에 화면에 유령처럼 남지 않도록 여기서도 같이 지운다.
  await supabase.from('watchlist_status').delete().eq('market', market).eq('ticker', ticker)

  revalidateTag(SCREENER_CACHE_TAG, { expire: 0 })
  return Response.json({ ok: true })
}
