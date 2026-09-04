// 홈 화면(app/page.tsx) 시황 위젯 쿼리 — 코스피·코스닥·다우존스·나스닥·S&P500 스냅샷.
// 환율은 fetchUsdKrwRate(shared.ts, frankfurter.app 직접 호출)를 그대로 재사용한다.
import { cacheLife, cacheTag } from 'next/cache'
import { createServerSupabaseClient } from '../supabase'
import { SCREENER_CACHE_TAG } from './shared'
import type { MarketIndexSnapshotRow } from '../types'

// 테이블 미생성(마이그레이션 전) 상태에서도 홈 화면이 깨지지 않도록 실패 시 빈 배열을 반환한다.
export async function getMarketIndexSnapshots(): Promise<MarketIndexSnapshotRow[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase.from('market_index_snapshot').select('*')
  if (error) return []
  return (data ?? []) as MarketIndexSnapshotRow[]
}
