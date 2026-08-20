import { notFound } from 'next/navigation'
import { ScorecardVerdict, SegmentTable } from '@/components/Scorecard'
import { PaperTradeTable, PaperTradeSummary } from '@/components/PaperTradeTable'
import { WatchlistCard } from '@/components/WatchlistCard'
import type { PaperPosition } from '@/lib/queries/trades'
import type { Scorecard, Segment } from '@/lib/scorecard'
import type { WatchlistStatusRow } from '@/lib/types'

/**
 * 픽스처로 화면을 그려보는 개발용 미리보기.
 *
 * 이 저장소는 DB 자격증명 없이 작업하는 경우가 있어(작업용 컨테이너·CI) 실제
 * 데이터로 화면을 못 띄운다. 그러면 UI 변경을 눈으로 확인할 방법이 빌드 성공
 * 여부밖에 없는데, 그건 "레이아웃이 깨졌는지 / 색이 맞는지"를 전혀 안 잡는다.
 * 여기에 대표적인 상태를 손으로 채워 두면 DB 없이도 렌더 결과를 볼 수 있다.
 *
 * 새 컴포넌트를 만들면 여기에 케이스를 추가할 것 — 특히 "값이 없을 때"와
 * "부호가 반대일 때"는 실제 데이터로는 좀처럼 안 나와서 놓치기 쉽다.
 */
function card(over: Partial<Scorecard>): Scorecard {
  return {
    resolved: 47, pending: 12, targetHits: 18, stops: 26, timeouts: 3,
    expectancyR: 0.34, totalR: 15.98, hitRate: 18 / 47,
    breakevenHitRate: 1 / 3, avgHoldingDays: 23,
    ...over,
  }
}

const BY_MISS: Segment[] = [
  { key: '0', label: '전 조건 통과', card: card({ expectancyR: 0.61, resolved: 11 }) },
  { key: '1', label: '1개 미달', card: card({ expectancyR: 0.24, resolved: 38 }) },
  { key: '2', label: '2개 미달', card: card({ expectancyR: -0.05, resolved: 52 }) },
  { key: '3', label: '3개 이상 미달', card: card({ expectancyR: -0.31, resolved: 40 }) },
]

const SEGMENTS: Segment[] = [
  { key: 'bull', label: '상승장', card: card({ expectancyR: 0.52, resolved: 28 }) },
  { key: 'bear', label: '하락장', card: card({ expectancyR: -0.11, resolved: 19 }) },
]

const SECTORS: Segment[] = [
  { key: 'semi', label: '반도체', card: card({ expectancyR: 0.71, resolved: 9 }) },
  { key: 'fin', label: '금융', card: card({ expectancyR: 0.08, resolved: 12 }) },
  { key: 'bio', label: '제약·바이오', card: card({ expectancyR: -0.43, resolved: 7 }) },
]

function pos(id: string, over: Partial<PaperPosition>): PaperPosition {
  return {
    id, market: 'KR', ticker: '005930', name: '삼성전자', sector: 'Semiconductors',
    source: 'pullback', entry_date: '2026-06-02', entry_price: 70000,
    exit_date: null, exit_price: null,
    currentPrice: 77000, currentDate: '2026-08-18', returnPct: 10,
    peakDrawdownPct: -3.2, holdingDays: 54, isOpen: true,
    exitSignal: null, signalReturnPct: null,
    ...over,
  }
}

const OPEN_POSITIONS: PaperPosition[] = [
  pos('open-1', {}),
  pos('open-2', { ticker: 'MU', market: 'US', name: '마이크론', source: 'opportunity',
    entry_price: 120, currentPrice: 104.4, returnPct: -13, peakDrawdownPct: -18.7, holdingDays: 12,
    exitSignal: { date: '2026-08-04', price: 111.6, reasons: ['bear', 'trend'] },
    signalReturnPct: -7 }),
  pos('open-3', { ticker: '035720', name: '카카오', entry_price: 50000, currentPrice: 46000,
    returnPct: -8, peakDrawdownPct: -12.1, holdingDays: 30,
    exitSignal: { date: '2026-07-21', price: 45000, reasons: ['stop'] },
    signalReturnPct: -10 }),
]

const CLOSED_POSITIONS: PaperPosition[] = [
  pos('closed-1', { ticker: '000660', name: 'SK하이닉스', entry_price: 180000, currentPrice: 214200,
    returnPct: 19, exit_date: '2026-08-10', exit_price: 214200,
    peakDrawdownPct: null, isOpen: false, holdingDays: 41,
    exitSignal: { date: '2026-07-15', price: 196200, reasons: ['sector'] }, signalReturnPct: 9 }),
  pos('closed-2', { ticker: 'DLTR', market: 'US', name: '달러트리', source: 'opportunity',
    entry_price: 95, currentPrice: 88.35, returnPct: -7, exit_date: '2026-07-28', exit_price: 88.35,
    peakDrawdownPct: null, isOpen: false, holdingDays: 22,
    exitSignal: { date: '2026-07-02', price: 91.2, reasons: ['trend'] }, signalReturnPct: -4 }),
]

function watch(over: Partial<WatchlistStatusRow>): WatchlistStatusRow {
  return {
    ticker: '000660', market: 'KR', name: 'SK하이닉스', date: '2026-08-19',
    qualified: true, reason: null, drawdown: -34, in_drawdown_band: true,
    no_new_low: true, box_ok: true, score: 0.72, days_since_low: 18,
    vcp: true, higher_lows: true, volume_dry: true, aligned_mas: true, volume_trigger: false,
    ...over,
  }
}

// 감시 종목 카드는 뉴스를 상시로 붙여 두므로, 로딩/빈 목록도 여기서 눈으로 볼 것.
const WATCHLIST: WatchlistStatusRow[] = [
  watch({}),
  watch({ ticker: '005930', name: '삼성전자', qualified: false, score: null,
    reason: '60일 박스폭 30% 초과', box_ok: false, higher_lows: null, vcp: null, volume_dry: null }),
]

export default function PreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound()

  return (
    <main className="mx-auto max-w-4xl space-y-8 px-4 py-8">
      <h1 className="text-2xl font-bold text-foreground">컴포넌트 미리보기 (개발용)</h1>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">성적 카드 — 상태별</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <ScorecardVerdict card={card({})} title="우위 있음 (본전선 위)" />
          <ScorecardVerdict
            card={card({ expectancyR: -0.28, targetHits: 9, stops: 35, hitRate: 9 / 47 })}
            title="우위 없음 (본전선 아래)"
          />
          <ScorecardVerdict
            card={card({ resolved: 8, pending: 30, expectancyR: 0.9, targetHits: 4, stops: 4, hitRate: 0.5 })}
            title="표본 부족"
          />
          <ScorecardVerdict card={card({ resolved: 0, pending: 5 })} title="판정 완료 0건" />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">감시 종목 카드 (뉴스는 실제 API 호출)</h2>
        <WatchlistCard rows={WATCHLIST} />
      </section>

      <section className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
        <h2 className="text-base font-semibold text-foreground">내 매매장 — 보유 중</h2>
        <PaperTradeTable items={OPEN_POSITIONS} showSell />
      </section>

      <section className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
        <h2 className="text-base font-semibold text-foreground">내 매매장 — 청산 완료</h2>
        <PaperTradeSummary closed={CLOSED_POSITIONS} />
        <PaperTradeTable items={CLOSED_POSITIONS} showSell={false} />
      </section>

      <section className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
        <h2 className="text-base font-semibold text-foreground">어떤 추천이 잘 맞았나</h2>
        <div className="space-y-5">
          <SegmentTable title="조건 충족도별" hint="화면에 뜨는 상위 후보 포함" segments={BY_MISS} />
          <SegmentTable title="장세별" segments={SEGMENTS} />
          <SegmentTable title="섹터별" hint="상위·하위" segments={SECTORS} />
        </div>
      </section>
    </main>
  )
}
