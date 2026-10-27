import { changeTextClass, changeTintClass } from '@/lib/marketColors'
import { formatKrwCompact } from '@/lib/investorFlow'
import type { KrExtrasSummary } from '@/lib/queries/krExtras'
import type { Market } from '@/lib/types'

/**
 * 접힌 카드에 붙는 요약 배지 — "펼쳐볼 만한 게 있나"를 한 줄로 알린다.
 *
 * 수급·컨센서스는 카드를 펼쳐야만 보였다. 매일 보는 화면에서 안 보이면
 * 없는 기능이나 마찬가지라, 여기에 숫자 몇 개만 미리 띄운다. 상세는 그대로
 * 펼쳤을 때 `MarketExtrasPanel`이 맡는다.
 *
 * **배지와 상세가 다른 숫자를 말하면 안 된다** — 연속 일수·누적 규칙은 상세 화면과
 * **같은 함수**(`summarizeFlow`)를 쓴다. 각자 세면 0인 날을 연속으로 볼지 같은
 * 사소한 차이로 두 곳이 다른 숫자를 말하게 된다.
 *
 * (배지는 원래 세 종류였다. 자사주 진행률 배지는 2026-10-27에 기능째 걷어냈다.)
 *
 * 서버 컴포넌트다(상태가 없다). 클라이언트 카드 안에서도 그대로 쓸 수 있다.
 */

function Chip({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`rounded-md px-1.5 py-0.5 text-[11px] leading-tight font-medium ${className}`}>
      {children}
    </span>
  )
}

export function KrExtrasBadges({
  summary,
  market,
  close = null,
  className = '',
}: {
  summary: KrExtrasSummary | undefined
  market: Market
  /** 최신 종가가 있으면 상승여력을 이걸로 다시 계산한다(저장은 하루 한 번뿐이라). */
  close?: number | null
  className?: string
}) {
  // 국내 종목 전용 데이터다. 미장 카드에서는 아무것도 그리지 않는다.
  if (market !== 'KR' || !summary) return null

  const chips: React.ReactNode[] = []

  if (summary.foreignDays > 0 && summary.foreignNetQty !== null) {
    const amount = summary.foreignNetAmount ?? 0
    chips.push(
      <Chip key="flow" className={changeTintClass(summary.foreignNetQty)}>
        외인 {summary.foreignDays}일{' '}
        {summary.foreignNetQty >= 0 ? '순매수' : '순매도'}{' '}
        {formatKrwCompact(Math.abs(amount))}
        {Math.abs(summary.foreignStreak) >= 3 &&
          ` · ${Math.abs(summary.foreignStreak)}일 연속`}
      </Chip>,
    )
  }

  if (summary.targetPrice !== null) {
    const upside =
      close && close > 0 ? (summary.targetPrice / close - 1) * 100 : summary.targetUpsidePct
    if (upside !== null) {
      chips.push(
        <Chip key="target" className={`bg-muted ${changeTextClass(upside)}`}>
          목표가 {upside >= 0 ? '+' : '−'}
          {Math.abs(upside).toFixed(0)}%
        </Chip>,
      )
    }
  }

  if (chips.length === 0) return null

  return <div className={`flex flex-wrap items-center gap-1 ${className}`}>{chips}</div>
}
