import type { WatchlistStatusRow } from '@/lib/types'

function CheckChip({ ok, label }: { ok: boolean | null; label: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${
        ok
          ? 'bg-emerald-50 font-medium text-emerald-700'
          : 'bg-gray-100 text-gray-500'
      }`}
    >
      {label} {ok ? '✓' : '✗'}
    </span>
  )
}

// 보유/감시 종목이 횡보·조정 스크리너 기준(매수 매력도)에 도달했는지 매일 보여주는 카드.
// 기준을 새로 통과한 날은 파이프라인이 GitHub 이슈로도 알린다 (watchlist.py).
export function WatchlistCard({ rows }: { rows: WatchlistStatusRow[] }) {
  if (rows.length === 0) return null

  return (
    <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-base font-semibold text-gray-900">감시 종목</h2>
        <p className="mt-0.5 text-xs text-gray-400">
          횡보·조정 스크리너 기준(조정폭 20~60% · 신저가 진정 · 박스 수축)으로 매일 평가합니다.
          기준을 새로 통과하면 GitHub 이슈로 알림이 갑니다.
        </p>
      </div>
      {rows.map((row) => (
        <div key={`${row.market}-${row.ticker}`} className="rounded-lg border border-gray-100 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-gray-900">
              {row.name || row.ticker}{' '}
              <span className="font-normal text-gray-400">({row.ticker})</span>
            </span>
            {row.qualified ? (
              <span className="rounded-full bg-emerald-600 px-2.5 py-0.5 text-xs font-semibold text-white">
                매수 기준 통과 · 매력도 {Math.round((row.score ?? 0) * 100)}점
              </span>
            ) : (
              <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
                대기 중
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <CheckChip ok={row.in_drawdown_band} label={`조정폭${row.drawdown != null ? ` ${row.drawdown.toFixed(0)}%` : ''}`} />
            <CheckChip ok={row.no_new_low} label="신저가 진정" />
            <CheckChip ok={row.box_ok} label="박스 수축" />
            {row.qualified && (
              <>
                <CheckChip ok={row.higher_lows} label="저점 높이기" />
                <CheckChip ok={row.vcp} label="VCP" />
                <CheckChip ok={row.volume_dry} label="거래량 소진" />
              </>
            )}
          </div>
          {!row.qualified && row.reason && (
            <p className="mt-2 text-xs text-gray-400">미달: {row.reason}</p>
          )}
          <p className="mt-1 text-xs text-gray-300">평가일: {row.date}</p>
        </div>
      ))}
    </section>
  )
}
