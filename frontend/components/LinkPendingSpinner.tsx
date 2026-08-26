'use client'

import { useLinkStatus } from 'next/link'

/**
 * 링크를 눌렀을 때 "눌렸다"는 걸 즉시 알려주는 스피너.
 *
 * 반드시 <Link> 안의 자식으로 렌더링해야 한다(useLinkStatus 제약). 대상 페이지가
 * 이미 프리페치돼 있으면(사이트 내 링크 대부분이 그렇다) 전환이 순식간이라
 * 애초에 뜨지 않고 스킵된다 — 프리페치가 아직 안 끝났거나 느린 연결일 때만 보인다.
 */
export function LinkPendingSpinner() {
  const { pending } = useLinkStatus()

  // 항상 같은 크기로 렌더링하고 보이기/숨기기만 토글한다 — pending일 때만
  // mount하면 그 순간 글자 옆에 아이콘 폭만큼 레이아웃이 밀리는 게 눈에 띈다.
  return (
    <svg
      aria-hidden="true"
      className={`ml-1.5 inline size-3 shrink-0 animate-spin align-[-1px] text-current transition-opacity ${
        pending ? 'opacity-100' : 'opacity-0'
      }`}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}
