import { Spinner } from './Spinner'

/**
 * Suspense fallback으로 쓰는 공용 로딩 표시. 실제 데이터 로딩(Supabase 쿼리 등)이
 * 걸리는 구간은 여기서 보여준다 — 클릭 직후의 짧은 틈만 담당하는 LinkPendingSpinner와
 * 달리, 이쪽이 사이트에서 체감되는 대기 시간 대부분을 커버한다.
 */
export function LoadingFallback({
  label = '로딩 중...',
  className = 'py-16',
}: {
  label?: string
  /** 상위 요소가 이미 패딩을 갖고 있으면(카드 안에 들어갈 때) 더 좁은 값으로 줄인다. */
  className?: string
}) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 text-muted-foreground ${className}`}>
      <Spinner className="size-5" />
      <p className="text-sm">{label}</p>
    </div>
  )
}
