'use client'

import { useLinkStatus } from 'next/link'
import { Spinner } from './Spinner'

/**
 * 링크를 눌렀을 때 "눌렸다"는 걸 즉시 알려주는 스피너 — 클릭과 라우터 전환 사이의
 * 아주 짧은 틈만 담당한다. 대상 페이지가 이미 프리페치돼 있으면(사이트 내 링크
 * 대부분이 그렇다) 이 틈이 너무 짧아 아예 뜨지도 않고 스킵된다. 전환 자체는 끝난
 * 뒤에도 이어지는 실제 데이터 로딩(Suspense fallback)은 이 컴포넌트가 아니라
 * LoadingFallback이 담당한다 — 둘을 혼동하면 "스피너가 안 돈다"고 오해하기 쉽다.
 *
 * 반드시 <Link> 안의 자식으로 렌더링해야 한다(useLinkStatus 제약).
 */
export function LinkPendingSpinner({
  className = 'ml-1.5 inline size-3 shrink-0 align-[-1px]',
}: {
  /** 기본은 텍스트 뒤에 붙는 인라인 배치. 버튼처럼 텍스트를 가운데 정렬해야 하는
   * 곳(NavLinks)에서는 레이아웃 폭에 안 끼도록 absolute 배치를 넘긴다 — 안 그러면
   * 보이지 않을 때도 오른쪽에 폭을 차지해 텍스트가 중앙에서 왼쪽으로 밀린다. */
  className?: string
}) {
  const { pending } = useLinkStatus()

  // 항상 같은 크기로 렌더링하고 보이기/숨기기만 토글한다 — pending일 때만
  // mount하면 그 순간 레이아웃이 밀리는 게 눈에 띈다.
  return <Spinner className={`${className} transition-opacity ${pending ? 'opacity-100' : 'opacity-0'}`} />
}
