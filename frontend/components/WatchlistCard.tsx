import type { WatchlistStatusRow } from '@/lib/types'
import { BUY_GRADE_CLASS, BUY_GRADE_CRITERIA, BUY_GRADE_LABEL, buyGrade } from '@/lib/buySignal'

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
// 파이프라인(watchlist.py)이 아침·저녁 실행마다 평가해 갱신한다.
export function WatchlistCard({ rows }: { rows: WatchlistStatusRow[] }) {
  if (rows.length === 0) return null

  // 초록불 조건 = 스크리너 기준 통과 + 매수 등급(관망 아님). 통과만으로는
  // 매수 신호로 보지 않는다 — 등급 기준은 횡보·조정 탭과 동일하다.
  const grades = new Map(
    rows.map((row) => [
      `${row.market}-${row.ticker}`,
      row.qualified ? buyGrade(row.score, row.higher_lows) : ('watch' as const),
    ]),
  )
  const anyQualified = [...grades.values()].some((grade) => grade !== 'watch')

  return (
    <section
      className={`space-y-3 rounded-xl border bg-white p-5 shadow-sm ${
        anyQualified ? 'border-emerald-400 ring-2 ring-emerald-100' : 'border-gray-200'
      }`}
    >
      <div>
        <h2 className="text-base font-semibold text-gray-900">
          감시 종목
          {anyQualified && (
            <span className="ml-2 rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white">
              📈 매수 신호 발생
            </span>
          )}
        </h2>
        <p className="mt-0.5 text-xs text-gray-400">
          횡보·조정 스크리너 기준(조정폭 20~60% · 신저가 진정 · 박스 수축)으로 매일 아침·저녁 평가합니다.
        </p>
        <p className="mt-1 text-xs text-emerald-700">
          <span className="font-medium">초록불 조건:</span> 위 기준 통과 + {BUY_GRADE_CRITERIA}
        </p>
      </div>
      {rows.map((row) => (
        <div
          key={`${row.market}-${row.ticker}`}
          className={`rounded-lg border p-3 ${
            grades.get(`${row.market}-${row.ticker}`) !== 'watch'
              ? 'border-emerald-300 bg-emerald-50/60'
              : 'border-gray-100'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-gray-900">
              {row.name || row.ticker}{' '}
              <span className="font-normal text-gray-400">({row.ticker})</span>
            </span>
            {row.qualified ? (
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                  BUY_GRADE_CLASS[grades.get(`${row.market}-${row.ticker}`) ?? 'watch']
                }`}
              >
                매력도 {Math.round((row.score ?? 0) * 100)}점 ·{' '}
                {BUY_GRADE_LABEL[grades.get(`${row.market}-${row.ticker}`) ?? 'watch']}
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
