import capitalSigungu from '@/lib/data/capital-sigungu.json'
import { formatManwon, priceMapColor, PRICE_SCALE_NO_DATA } from '@/lib/realestateTrend'
import type { RegionTrend } from '@/lib/realestateTrend'

export function RealestateMap({ regions }: { regions: RegionTrend[] }) {
  const priceByCode = new Map<string, number>()
  for (const r of regions) {
    if (r.latest.price_avg != null) priceByCode.set(r.region_code, r.latest.price_avg)
  }
  const prices = [...priceByCode.values()]
  if (prices.length === 0) return null

  const min = Math.min(...prices)
  const max = Math.max(...prices)

  return (
    <div>
      <svg
        viewBox={capitalSigungu.viewBox}
        className="mx-auto block w-full max-w-md [&_path]:transition-opacity [&_path:hover]:opacity-70"
      >
        {capitalSigungu.regions.map((r) => {
          const price = priceByCode.get(r.region_code)
          const fill = price != null ? priceMapColor(price, min, max) : PRICE_SCALE_NO_DATA
          return (
            <a key={r.region_code} href={`/realestate?region=${r.region_code}`}>
              <path d={r.d} fill={fill} stroke="#fff" strokeWidth={0.75}>
                <title>
                  {r.region_name}
                  {price != null ? ` — ${formatManwon(price)}` : ' — 데이터 없음'}
                </title>
              </path>
            </a>
          )
        })}
      </svg>
      <div className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <span>{formatManwon(min)}</span>
        <div
          className="h-2 w-32 rounded-full"
          style={{ background: `linear-gradient(to right, ${priceMapColor(min, min, max)}, ${priceMapColor(max, min, max)})` }}
        />
        <span>{formatManwon(max)}</span>
      </div>
      <p className="mt-1 text-center text-[10px] break-keep text-muted-foreground/70">
        지도 경계: 통계청 SGIS(2018년 기준), 공공누리 제1유형 · 회색은 이번 달 매매 데이터 없음
      </p>
    </div>
  )
}
