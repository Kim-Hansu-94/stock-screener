import { revalidateTag } from 'next/cache'
import { createServerSupabaseClient } from '@/lib/supabase'
import { SCREENER_CACHE_TAG } from '@/lib/queries/shared'
import { checkTradePin } from '@/lib/tradeAuth'
import type { Market } from '@/lib/types'

/**
 * 가상 매매장 쓰기 경로. 조회는 서버 컴포넌트가 직접 하고, 여기서는 매수/매도만 받는다.
 *
 * 가격을 클라이언트에서 받지 않는 게 핵심이다. 브라우저가 보낸 값을 그대로 저장하면
 * 아무 가격이나 넣어 수익률을 조작할 수 있으므로, 진입가/청산가는 항상 서버가
 * stock_price_history의 최신 종가를 직접 읽어서 채운다.
 */

async function latestClose(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  market: Market,
  ticker: string,
): Promise<{ date: string; close: number } | null> {
  const { data } = await supabase
    .from('stock_price_history')
    .select('date, close')
    .eq('market', market)
    .eq('ticker', ticker)
    .order('date', { ascending: false })
    .limit(1)

  const row = (data ?? [])[0] as { date: string; close: number } | undefined
  if (!row || !(row.close > 0)) return null
  return { date: row.date, close: Number(row.close) }
}

// 매수 — 최신 종가로 포지션을 연다.
export async function POST(request: Request) {
  const pin = checkTradePin(request)
  if (!pin.ok) return Response.json({ error: pin.error }, { status: pin.status })

  let body: { market?: string; ticker?: string; name?: string; sector?: string; source?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 })
  }

  const market = body.market === 'KR' || body.market === 'US' ? body.market : null
  const ticker = typeof body.ticker === 'string' ? body.ticker.trim() : ''
  if (!market || !ticker) {
    return Response.json({ error: 'market과 ticker가 필요합니다.' }, { status: 400 })
  }
  const source = body.source === 'opportunity' ? 'opportunity' : 'pullback'

  const supabase = createServerSupabaseClient()
  const bar = await latestClose(supabase, market, ticker)
  if (!bar) {
    return Response.json(
      { error: '이 종목의 가격 데이터가 없어 매수를 기록할 수 없습니다.' },
      { status: 422 },
    )
  }

  const { data, error } = await supabase
    .from('paper_trades')
    .insert({
      market,
      ticker,
      name: (body.name ?? ticker).slice(0, 200),
      sector: (body.sector ?? '').slice(0, 100),
      source,
      entry_date: bar.date,
      entry_price: bar.close,
    })
    .select('id')
    .single()

  if (error) {
    // 부분 유니크 인덱스(열린 포지션 1개)에 걸린 경우 — 중복 클릭이지 오류가 아니다.
    if (error.code === '23505') {
      return Response.json({ error: '이미 보유 중인 종목입니다.' }, { status: 409 })
    }
    return Response.json({ error: error.message }, { status: 500 })
  }

  revalidateTag(SCREENER_CACHE_TAG, { expire: 0 })
  return Response.json({ id: data.id, entryDate: bar.date, entryPrice: bar.close })
}

// 매도 — 최신 종가로 포지션을 닫는다.
export async function PATCH(request: Request) {
  const pin = checkTradePin(request)
  if (!pin.ok) return Response.json({ error: pin.error }, { status: pin.status })

  let body: { id?: string }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 })
  }
  const id = typeof body.id === 'string' ? body.id : ''
  if (!id) return Response.json({ error: 'id가 필요합니다.' }, { status: 400 })

  const supabase = createServerSupabaseClient()
  const { data: trade } = await supabase
    .from('paper_trades')
    .select('id, market, ticker, exit_date')
    .eq('id', id)
    .single()

  if (!trade) return Response.json({ error: '없는 기록입니다.' }, { status: 404 })
  if (trade.exit_date) return Response.json({ error: '이미 매도된 기록입니다.' }, { status: 409 })

  const bar = await latestClose(supabase, trade.market as Market, trade.ticker)
  if (!bar) {
    return Response.json({ error: '가격 데이터가 없어 매도를 기록할 수 없습니다.' }, { status: 422 })
  }

  const { error } = await supabase
    .from('paper_trades')
    .update({ exit_date: bar.date, exit_price: bar.close, closed_at: new Date().toISOString() })
    .eq('id', id)
    .is('exit_date', null) // 동시에 두 번 눌러도 한 번만 닫히도록

  if (error) return Response.json({ error: error.message }, { status: 500 })

  revalidateTag(SCREENER_CACHE_TAG, { expire: 0 })
  return Response.json({ id, exitDate: bar.date, exitPrice: bar.close })
}
