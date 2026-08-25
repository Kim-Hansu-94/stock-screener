import { Suspense } from 'react'
import { getRealestateMonthly } from '@/lib/queries/realestate'
import { AREA_BANDS, regionOverview, regionRows, withMomChange, type DetailMonthRow } from '@/lib/realestateTrend'
import { RealestateOverviewTable, RealestateDetailTable } from '@/components/RealestateTables'
import { RealestateMap } from '@/components/RealestateMap'
import type { AreaBand } from '@/lib/types'

async function RealestateContent({
  searchParams,
}: {
  searchParams: Promise<{ region?: string }>
}) {
  // searchParams는 요청 시점에만 값을 아는 캐시 불가 API라, Suspense 밖(페이지
  // 최상위)에서 await하면 Cache Components 빌드가 "Uncached data accessed outside
  // of Suspense"로 막는다 — Suspense로 감싼 이 컴포넌트 안에서 읽어야 한다.
  const { region: regionCode } = await searchParams

  // 개요(지역 목록)와 상세(지역 전 구간) 둘 다 같은 원본에서 파생되므로 한 번만 받는다
  // ('use cache'가 걸려 있어 지역을 바꿔가며 봐도 Supabase는 다시 안 부른다).
  const rows = await getRealestateMonthly()

  if (!regionCode) {
    const overview = regionOverview(rows)
    const hasPricedRegion = overview.some((r) => r.latest.price_avg != null)
    return (
      <div className="space-y-5">
        {hasPricedRegion && (
          <section className="rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
            <h2 className="mb-4 text-base font-bold text-foreground">지역별 매매가 지도</h2>
            <RealestateMap regions={overview} />
          </section>
        )}
        <section className="rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
          <RealestateOverviewTable regions={overview} />
        </section>
      </div>
    )
  }

  const forRegion = regionRows(rows, regionCode)
  const regionName = forRegion[0]?.region_name ?? regionCode
  const byBand = {} as Record<AreaBand, DetailMonthRow[]>
  for (const band of AREA_BANDS) {
    byBand[band] = withMomChange(forRegion.filter((r) => r.area_band === band))
  }

  return (
    <section className="rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
      <RealestateDetailTable regionName={regionName} byBand={byBand} />
    </section>
  )
}

export default function RealestatePage({
  searchParams,
}: {
  searchParams: Promise<{ region?: string }>
}) {
  return (
    // w-full이 없으면 <body>의 flex-column 아래에서 <main>이 폭 넓은 표(구간별 상세)의
    // 내용에 끌려 스트레치 대신 콘텐츠 폭으로 커진다 — overflow-x-auto로 표 자체는
    // 감쌌는데도 그렇다. 폰에서 네비게이션까지 옆으로 밀리는 걸로 실측 확인함.
    <main className="mx-auto w-full max-w-3xl space-y-5 px-4 py-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">부동산 동향</h1>
        <p className="text-sm text-muted-foreground">
          수도권(서울·인천·경기) 아파트 매매·전월세 실거래가를 시군구 단위로 집계했습니다.
          국토교통부 실거래가 공개시스템 기준이며, 신고 기한(계약 후 30일)이 있어 최근
          1~2개월은 숫자가 나중에 더 올라올 수 있습니다.
        </p>
      </div>

      <Suspense fallback={<p className="py-16 text-center text-muted-foreground">로딩 중...</p>}>
        <RealestateContent searchParams={searchParams} />
      </Suspense>
    </main>
  )
}
