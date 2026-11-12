/**
 * 포지션 관리 카드가 **지금 화면에 띄우고 있는 숫자**를 DB 값으로 그대로 재현하는 진단.
 *
 * 왜 필요한가
 * -----------
 * "화면에 뜬 SK하이닉스 지지신호가 최신이고 맞는 값인가"를 확인할 길이 없었다.
 * db_probe는 일봉이 몇 봉 있는지까지만 찍고, 지지신호 5개는 프론트에서 계산하므로
 * 저장된 값이 아니다. 그래서 화면과 **같은 함수**로 다시 계산해 찍는다.
 *
 * **파이썬으로 포팅하지 않는다** — Node 22가 타입만 벗겨 `.ts`를 그대로 실행하므로
 * 화면이 쓰는 `assessSupportSignals`를 그대로 import한다(`backtestEtfStage.ts`와 같은
 * 원칙). 포팅본을 만들면 `opportunityScore.ts` ↔ `watchlist.py`처럼 갈라질 동기화
 * 지점이 하나 더 생기고, 그러면 "프로브는 맞다는데 화면은 다르다"가 가능해진다.
 *
 * 읽기만 한다 — DB·사이트에 아무것도 쓰지 않는다.
 *
 * 실행: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node research/checkPositionSignals.ts
 * 작업 컨테이너에는 자격증명이 없어 `.github/workflows/position_signals_probe.yml`로 돌린다.
 */

import { createClient } from '@supabase/supabase-js'
import {
  assessSupportSignals,
  drawdownFromHigh,
  profitLossPct,
  summarizeSupportSignals,
} from '../lib/supportSignals.ts'
import { summarizeFlow } from '../lib/investorFlow.ts'
import type { PriceHistoryRow } from '../lib/types.ts'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_KEY
if (!url || !key) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY 가 필요합니다.')
  process.exit(1)
}
const db = createClient(url, key)

/**
 * 화면(`app/pullback/page.tsx`의 `SIGNAL_BARS_DAYS`)이 받는 구간과 같은 값.
 * 여기가 어긋나면 프로브와 화면이 **다른 일봉으로** 판정하게 된다 — 손으로 맞춰야 하는
 * 동기화 지점이다. 2026-11-11에 180 → 240으로 같이 올렸다(180일이면 거래일로 딱 120봉이라
 * 120일선이 공휴일 하나에 조용히 판정 불가가 됐다 — 이 프로브가 찾아낸 값이다).
 */
const SIGNAL_BARS_DAYS = 240

const line = () => console.log('─'.repeat(78))
const won = (v: number) => Math.round(v).toLocaleString('ko-KR')

async function bars(market: string, ticker: string): Promise<PriceHistoryRow[]> {
  // getPriceHistoryByTicker와 같은 조회(그쪽은 'use cache'라 Next 밖에서는 못 부른다).
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - SIGNAL_BARS_DAYS)
  const { data, error } = await db
    .from('stock_price_history')
    .select('ticker, market, date, open, high, low, close, volume')
    .eq('market', market)
    .eq('ticker', ticker)
    .gte('date', cutoff.toISOString().slice(0, 10))
    .order('date', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as PriceHistoryRow[]
}

async function main() {
  const { data: tickers, error } = await db
    .from('watchlist_tickers')
    .select('market, ticker, name, added_at, category, avg_cost')
    .eq('category', 'position')
    .order('added_at', { ascending: true })
  if (error) throw new Error(error.message)

  console.log(`\n보유 종목(category='position') ${tickers?.length ?? 0}개`)
  if (!tickers || tickers.length === 0) {
    console.log('  없음 — 포지션 관리 카드가 빈 상태로 뜬다는 뜻이다.')
    return
  }

  for (const t of tickers) {
    line()
    console.log(`▶ ${t.name || t.ticker} (${t.market} ${t.ticker})`)
    console.log(`  평단가(avg_cost): ${t.avg_cost == null ? '미설정' : won(t.avg_cost) + '원'}`)

    const rows = await bars(t.market, t.ticker)
    if (rows.length === 0) {
      console.log('  일봉 0봉 — 카드가 "일봉 데이터 부족"으로 뜬다.')
      continue
    }
    const latest = rows[rows.length - 1]
    console.log(
      `  일봉 ${rows.length}봉 · ${rows[0].date} ~ ${latest.date} (최근 ${SIGNAL_BARS_DAYS}일 창)`,
    )
    console.log('  최근 일봉 5개 (DB 저장값 그대로):')
    for (const b of rows.slice(-5).reverse()) {
      console.log(
        `    ${b.date}  시 ${won(b.open)}  고 ${won(b.high)}  저 ${won(b.low)}  종 ${won(b.close)}  거래량 ${b.volume.toLocaleString('ko-KR')}`,
      )
    }

    const pl = profitLossPct(t.avg_cost, latest.close)
    const dd = drawdownFromHigh(rows)
    console.log(`  현재가 ${won(latest.close)}원 · 평단 대비 ${pl === null ? '—' : pl.toFixed(2) + '%'}`)
    console.log(`  구간 최고가 대비 ${dd === null ? '—' : dd.toFixed(2) + '%'}`)

    const assessment = assessSupportSignals(rows)
    console.log(`\n  지지신호 ${assessment.metCount}/${assessment.evaluatedCount} 충족:`)
    for (const s of assessment.signals) {
      const mark = s.met === null ? '—' : s.met ? '✓' : '✗'
      console.log(`    [${mark}] ${s.label}: ${s.detail}`)
    }
    const summary = summarizeSupportSignals(assessment)
    console.log(`\n  코멘트: ${summary ? summary.text : '(판정된 조건 없음)'}`)

    if (t.market !== 'KR') continue

    // 접힌 카드의 배지 — 수급·목표가. 값이 없는 게 정상 상태일 수 있다.
    const { data: flow } = await db
      .from('investor_flow')
      .select('date, foreign_net_qty, foreign_net_amount, institution_net_qty, institution_net_amount')
      .eq('ticker', t.ticker)
      .order('date', { ascending: true })
    const flowRows = flow ?? []
    if (flowRows.length === 0) {
      console.log('\n  수급(investor_flow): 행 없음')
    } else {
      const f = summarizeFlow(flowRows, 'foreign')
      console.log(
        `\n  수급(investor_flow): ${flowRows.length}행 · ${flowRows[0].date} ~ ${flowRows[flowRows.length - 1].date}`,
      )
      console.log(
        `    외국인 ${f.days}일 누적 ${f.netQty.toLocaleString('ko-KR')}주 · 매수일 ${f.buyDays}일 · 연속 ${f.streak}일`,
      )
    }

    const { data: con } = await db
      .from('stock_consensus')
      .select('*')
      .eq('ticker', t.ticker)
      .limit(1)
    if (!con || con.length === 0) {
      console.log('  컨센서스(stock_consensus): 행 없음')
    } else {
      const c = con[0] as Record<string, unknown>
      console.log(`  컨센서스(stock_consensus): ${JSON.stringify(c)}`)
    }

    // ── 추가 매수 계획을 세우려면 '지금 숫자'만으로는 모자란다 ──────────
    // 물타기 금액·가격대를 정하려면 (1) 이 주식이 어디까지 갔던 주식인지,
    // (2) 실적이 같이 무너진 건지 가격만 빠진 건지를 알아야 한다. 둘 다 DB에 있는데
    // 화면에는 안 나오므로 여기서 찍는다 — **추정하지 않고 저장값을 그대로 인용한다.**
    const anchors = rows.map((r) => r.close)
    if (anchors.length > 0) {
      const hi = Math.max(...anchors)
      const lo = Math.min(...anchors)
      const sma = (n: number) =>
        anchors.length >= n ? anchors.slice(-n).reduce((a, b) => a + b, 0) / n : null
      const s60 = sma(60)
      const s120 = sma(120)
      console.log(`\n  가격 기준점 (최근 ${anchors.length}봉)`)
      console.log(`    구간 고가 ${won(hi)}원 · 저가 ${won(lo)}원 · 현재 ${won(latest.close)}원`)
      console.log(
        `    60일선 ${s60 ? won(s60) + '원' : '—'} · 120일선 ${s120 ? won(s120) + '원' : '—'}`,
      )
    }

    // 10년 월봉 — 이 주식의 역대 고점. 목표가를 상상하기 전에 실제 최고가를 본다.
    const { data: monthly } = await db
      .from('stock_long_monthly')
      .select('month, close, close_high')
      .eq('market', t.market)
      .eq('ticker', t.ticker)
      .order('month', { ascending: false })
      .limit(130)
    if (monthly && monthly.length > 0) {
      const highs = monthly
        .map((m) => ({ month: m.month as string, v: Number(m.close_high ?? m.close) }))
        .filter((m) => Number.isFinite(m.v))
      const peak = highs.reduce((a, b) => (b.v > a.v ? b : a), highs[0])
      console.log(
        `    10년 월봉 ${monthly.length}개월 · 역대 고점 ${won(peak.v)}원 (${peak.month})` +
          ` · 지금은 그 대비 ${(((latest.close - peak.v) / peak.v) * 100).toFixed(1)}%`,
      )
    } else {
      console.log('    10년 월봉(stock_long_monthly): 행 없음')
    }

    // 실적 — "가격만 빠진 건가, 실적도 같이 꺾인 건가"
    const { data: fund } = await db
      .from('stock_fundamentals')
      .select('*')
      .eq('market', t.market)
      .eq('ticker', t.ticker)
      .limit(1)
    if (!fund || fund.length === 0) {
      console.log('    실적(stock_fundamentals): 행 없음')
    } else {
      console.log(`    실적(stock_fundamentals): ${JSON.stringify(fund[0])}`)
    }
  }

  line()
  console.log('\n※ 위 지지신호는 화면이 쓰는 assessSupportSignals를 그대로 돌린 결과다.')
  console.log('  화면과 다르게 나오면 일봉 창(SIGNAL_BARS_DAYS)이 어긋났는지부터 볼 것.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
