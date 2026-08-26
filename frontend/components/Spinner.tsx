// 로딩 중임을 보여주는 공용 스피너. 링크 클릭 힌트(LinkPendingSpinner)와
// 섹션 로딩 표시(LoadingFallback)가 같은 모양을 공유하도록 여기 하나로 둔다.
export function Spinner({ className = 'size-4' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`${className} animate-spin text-current`}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}
