import { Suspense } from 'react'
import { connection } from 'next/server'
import { LoadingFallback } from '@/components/LoadingFallback'
import {
  getScorecardTrades,
  getScreenedStockPerformance,
  getRegimesInRange,
  getPatternRecommendations,
} from '@/lib/queries/performance'
import { segmentBy, summarize, MIN_SEGMENT_SAMPLE, MAX_HOLD_BARS } from '@/lib/scorecard'
import {
  DAYS_SINCE_LOW_LABEL,
  DRAWDOWN_LABEL,
  MIN_PATTERN_SAMPLE,
  PATTERN_HOLD_BARS,
  RANK_LABEL,
  daysSinceLowBucket,
  drawdownBucket,
  rankBucket,
  segmentPatternBy,
  summarizePattern,
} from '@/lib/patternScorecard'
import { translateSector } from '@/lib/sectorMap'
import { PerformanceTable } from '@/components/PerformanceTable'
import { ScorecardVerdict, SegmentTable } from '@/components/Scorecard'
import { PatternScorecardVerdict, PatternSegmentTable } from '@/components/PatternScorecard'
import type { ResolvedTrade } from '@/lib/scorecard'
import type { PatternFeatures, ResolvedPatternRec } from '@/lib/patternScorecard'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  )
}

function Segments({ trades }: { trades: ResolvedTrade[] }) {
  // 가장 실용적인 질문: 전 조건 통과는 드무니, 미달 1~2개짜리 후보도 따라갈 만한가?
  // (화면에 매일 뜨는 게 실제로는 이쪽이다.)
  const byMiss = segmentBy(
    trades,
    (t) => String(Math.min(t.missCount, 3)),
    (k) => (k === '0' ? '전 조건 통과' : k === '3' ? '3개 이상 미달' : `${k}개 미달`),
  ).sort((a, b) => Number(a.key) - Number(b.key))

  const byRegime = segmentBy(
    trades,
    (t) => t.regime,
    (k) => (k === 'bull' ? '상승장' : '하락장'),
  )
  const byMarket = segmentBy(
    trades,
    (t) => t.market,
    (k) => (k === 'KR' ? '한국' : '미국'),
  )
  const bySector = segmentBy(trades, (t) => t.sector || null, translateSector)

  if (byMiss.length === 0 && byRegime.length === 0 && byMarket.length === 0 && bySector.length === 0) {
    return null
  }

  return (
    <Section title="어떤 추천이 잘 맞았나">
      <p className="text-xs text-muted-foreground">
        구간마다 추천 1건당 평균 손익입니다. 오른쪽(빨강)으로 뻗을수록 그 구간에서 잘 통했다는 뜻입니다.
        표본 {MIN_SEGMENT_SAMPLE}건 미만인 구간은 착시라 뺐습니다.
      </p>
      <div className="space-y-5">
        <SegmentTable title="조건 충족도별" hint="화면에 뜨는 상위 후보 포함" segments={byMiss} />
        <SegmentTable title="장세별" segments={byRegime} />
        <SegmentTable title="시장별" segments={byMarket} />
        <SegmentTable title="섹터별" hint="상위·하위" segments={bySector.slice(0, 8)} />
      </div>
    </Section>
  )
}

/**
 * 저점 매집 후보 성적 — 눌림목과 다른 알고리즘이라 집계 틀도 다르다(단위가 R이 아니라 %).
 *
 * 특성별 표(저점 유지 기간·하락률·VCP…)는 추천 시점의 계산 근거가 있어야 나온다.
 * `supabase/recommendation_history_features.sql`을 실행하기 전에 쌓인 추천은 근거가
 * 없어 구간에서 빠지므로, 표가 비는 것이 고장이 아니라는 걸 화면에 밝혀 둔다.
 */
function PatternFeatureSegments({ recs }: { recs: ResolvedPatternRec[] }) {
  const boolSegments = (pick: (f: PatternFeatures) => boolean | null, yes: string, no: string) =>
    segmentPatternBy(
      recs,
      (r) => {
        const value = pick(r.features)
        return value === null ? null : value ? 'y' : 'n'
      },
      (k) => (k === 'y' ? yes : no),
    )

  const byDays = segmentPatternBy(
    recs,
    (r) => daysSinceLowBucket(r.features.daysSinceLow),
    (k) => DAYS_SINCE_LOW_LABEL[k],
  )
  const byDrawdown = segmentPatternBy(
    recs,
    (r) => drawdownBucket(r.features.drawdownPct),
    (k) => DRAWDOWN_LABEL[k],
  )
  const byVcp = boolSegments((f) => f.vcp, 'VCP 충족', 'VCP 미충족')
  const byMaAlign = boolSegments((f) => f.maAlign, '이평 정배열', '정배열 아님')
  const byVolume = boolSegments((f) => f.volumeTriggered, '거래량 터짐', '거래량 평범')

  const hasAny = [byDays, byDrawdown, byVcp, byMaAlign, byVolume].some((s) => s.length > 0)
  if (!hasAny) {
    return (
      <p className="text-xs text-muted-foreground">
        특성별 표는 추천 시점의 계산 근거(저점 유지 기간·하락률·VCP 여부)가 기록된 추천부터
        나옵니다. 기록은 <code className="font-mono">supabase/recommendation_history_features.sql</code>을
        실행한 날부터 쌓이고, 그 뒤 {PATTERN_HOLD_BARS}거래일이 지나야 판정이 끝나 표에 들어옵니다.
      </p>
    )
  }

  return (
    <div className="space-y-5">
      <PatternSegmentTable
        title="저점 유지 기간별"
        hint="점수 가중치가 가장 큰 항목"
        segments={byDays}
      />
      <PatternSegmentTable title="하락률 구간별" segments={byDrawdown} />
      <PatternSegmentTable title="VCP 충족 여부" segments={byVcp} />
      <PatternSegmentTable title="이평 정배열 여부" segments={byMaAlign} />
      <PatternSegmentTable title="거래량 배지 여부" segments={byVolume} />
    </div>
  )
}

async function PatternSection() {
  // HistoryContent와 같은 이유로 동적 렌더를 선언한다 — 이게 없으면 빌드 시점에
  // 프리렌더를 시도하다 DB 조회로 실패한다(작업 컨테이너엔 자격증명이 없다).
  await connection()

  const recs = await getPatternRecommendations()
  if (recs.length === 0) return null

  const card = summarizePattern(recs)
  const byRank = segmentPatternBy(recs, (r) => rankBucket(r.rank), (k) => RANK_LABEL[k])
  const bySector = segmentPatternBy(recs, (r) => r.sector || null, translateSector)

  return (
    <>
      <div className="space-y-1">
        <h2 className="text-lg font-bold tracking-tight text-foreground">저점 매집 후보 성적</h2>
        <p className="text-sm text-muted-foreground">
          종목발굴 탭의 저점 매집 후보를 추천일 종가에 사서 {PATTERN_HOLD_BARS}거래일(약 3개월)
          들고 있었다면 어땠을지를 봅니다. 이 탭은 손절·목표가를 정하지 않으므로 눌림목 성적처럼
          R(손절폭 배수)이 아니라 <strong className="font-medium">수익률(%)</strong>로 잽니다. 같은
          종목이 여러 날 반복 추천되면 첫 추천 하나만 셉니다.
        </p>
      </div>

      <PatternScorecardVerdict card={card} title="미국 시장 (저점 매집 후보)" />

      {(byRank.length > 0 || bySector.length > 0) && (
        <Section title="어떤 후보가 잘 맞았나">
          <p className="text-xs text-muted-foreground">
            구간마다 추천 1건당 평균 수익률입니다. 표본 {MIN_PATTERN_SAMPLE}건 미만인 구간은
            착시라 뺐습니다.
          </p>
          <div className="space-y-5">
            <PatternSegmentTable
              title="점수 순위별"
              hint="위 순위가 실제로 나았는지 = 점수 공식이 작동하는지"
              segments={byRank}
            />
            <PatternSegmentTable title="섹터별" hint="상위·하위" segments={bySector.slice(0, 8)} />
          </div>
          <PatternFeatureSegments recs={recs} />
        </Section>
      )}
    </>
  )
}

async function HistoryContent() {
  await connection()

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const [krTrades, usTrades, krPerf, usPerf, krRegimes, usRegimes] = await Promise.all([
    getScorecardTrades('KR'),
    getScorecardTrades('US'),
    getScreenedStockPerformance('KR', 30),
    getScreenedStockPerformance('US', 30),
    getRegimesInRange('KR', cutoffStr),
    getRegimesInRange('US', cutoffStr),
  ])

  const allTrades = [...krTrades, ...usTrades]

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <ScorecardVerdict card={summarize(krTrades)} title="한국 시장" />
        <ScorecardVerdict card={summarize(usTrades)} title="미국 시장" />
      </div>

      <Segments trades={allTrades} />

      {krPerf.length > 0 && (
        <Section title="한국 — 최근 30일 추천 목록">
          <PerformanceTable items={krPerf} market="KR" regimes={krRegimes} />
        </Section>
      )}

      {usPerf.length > 0 && (
        <Section title="미국 — 최근 30일 추천 목록">
          <PerformanceTable items={usPerf} market="US" regimes={usRegimes} />
        </Section>
      )}

      {allTrades.length === 0 && krPerf.length === 0 && usPerf.length === 0 && (
        <p className="text-sm text-muted-foreground">아직 추천 이력이 없습니다.</p>
      )}
    </>
  )
}

export default function HistoryPage() {
  return (
    <main className="mx-auto max-w-4xl space-y-5 px-4 py-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">스크리너 성적</h1>
        <p className="text-sm text-muted-foreground">
          홈 화면에 뜬 종목을 그대로 샀다면 어땠을지를 봅니다. 10개 조건을 전부 채우는 날은
          드물어서 상위 후보(미달 1~2개)까지 함께 집계하고, 조건 충족도별로 성적을 갈라
          보여줍니다. 추천일 종가에 사서 목표가에 팔거나 손절가에 걸리는 것으로 가정하고,
          {MAX_HOLD_BARS}거래일 안에 둘 다 안 걸리면 그날 종가로 정리한 것으로 칩니다.
        </p>
        <p className="text-sm text-muted-foreground">
          아래쪽에는 종목발굴 탭의 <strong className="font-medium">저점 매집 후보</strong> 성적이
          따로 있습니다. 알고리즘이 달라 재는 방식도 다릅니다.
        </p>
      </div>

      <Suspense fallback={<LoadingFallback />}>
        <HistoryContent />
      </Suspense>

      {/* 저점 매집 후보는 다른 알고리즘·다른 조회라 Suspense를 따로 둔다 —
          한쪽 조회가 느려도 다른 쪽이 먼저 그려진다. */}
      <Suspense fallback={<LoadingFallback />}>
        <PatternSection />
      </Suspense>
    </main>
  )
}
