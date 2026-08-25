// 부동산 동향 탭(app/realestate) 쿼리.
import { cacheLife, cacheTag } from 'next/cache'
import { createServerSupabaseClient } from '../supabase'
import { SCREENER_CACHE_TAG } from './shared'
import type { RealestateMonthlyRow } from '../types'

// 한 줄 리터럴로 둔다 — 문자열을 런타임에 이어붙이면(`+`) supabase-js가 select()의
// 컬럼 목록에서 반환 타입을 추론하지 못해 GenericStringError로 무너진다.
const COLUMNS =
  'region_code, region_name, month, area_band, deal_count, price_avg, price_median, price_per_area_avg, jeonse_count, deposit_avg, deposit_median, monthly_rent_count, jeonse_ratio, gap_avg'
const PAGE = 1000

// 수도권 최대 77개 시군구 × 최대 36개월 × 5개 구간(ALL+4)이라 이론상 13,860행까지
// 갈 수 있다. PostgREST가 max_rows=1000에서 자르므로 페이지네이션한다(shared.ts의
// fetchPriceRowsPaged와 같은 이유). 지역·기간별로 나눠 읽지 않고 통째로 한 번에
// 캐싱하는 이유는 개요(지역 목록)와 상세(지역별 전 구간) 둘 다 같은 원본에서
// 파생되는 뷰라서, 화면이 바뀔 때마다 다시 쿼리하지 않고 여기서 한 번만 받아
// lib/realestateTrend.ts의 순수 함수로 나눠 쓰기 위해서다.
export async function getRealestateMonthly(): Promise<RealestateMonthlyRow[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()

  const rows: RealestateMonthlyRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('realestate_monthly')
      .select(COLUMNS)
      .order('region_code', { ascending: true })
      .order('month', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return rows
    rows.push(...((data ?? []) as RealestateMonthlyRow[]))
    if (!data || data.length < PAGE) break
  }
  return rows
}
