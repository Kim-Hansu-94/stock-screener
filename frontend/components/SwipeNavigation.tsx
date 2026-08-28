'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { LINKS } from '@/app/navLinks'

// 이 이상 가로로 움직여야 "탭 전환 의도"로 본다 — 손가락이 살짝 떨리는 정도의
// 짧은 이동은 그냥 탭(클릭)이나 스크롤 시작으로 봐야 한다.
const SWIPE_MIN_DISTANCE = 60
// 가로 이동이 세로 이동보다 이만큼(비율) 커야 "가로 스와이프"로 확정한다.
// 안 그러면 위아래로 스크롤하려던 대각선 손짓도 탭 전환으로 오인한다.
const SWIPE_DOMINANCE_RATIO = 1.5

/**
 * 상단 탭 사이를 좌우로 밀어서 이동하는 제스처. 페이지 콘텐츠 영역에만 붙이고
 * (헤더는 형제 요소라 자동으로 제외) 아래 경우는 스와이프 판정에서 뺀다 —
 * 이미 자기 나름의 좌우 제스처를 쓰는 요소들과 충돌하면 안 되므로:
 *   - 표(overflow-x-auto)처럼 가로 스크롤이 있는 요소 — 표 스크롤이 우선이어야 함
 *   - 부동산 지도(SVG) — 확대/드래그 이동이 이미 좌우 제스처를 씀
 *   - 캔들 차트(lightweight-charts, canvas) — 차트 팬/줌이 이미 좌우 제스처를 씀
 */
export function SwipeNavigation({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const touch = {
      active: false,
      startX: 0,
      startY: 0,
    }

    function isExcluded(target: EventTarget | null): boolean {
      if (!(target instanceof Element)) return false
      let node: Element | null = target
      while (node && node !== el) {
        // SVG 요소의 tagName은 HTML과 달리 소문자('svg')로 온다 — 대소문자 구분 없이 비교.
        const tag = node.tagName.toUpperCase()
        if (tag === 'SVG' || tag === 'CANVAS') return true
        if (node.hasAttribute('data-swipe-ignore')) return true
        const style = getComputedStyle(node)
        const scrollsX = (style.overflowX === 'auto' || style.overflowX === 'scroll') && node.scrollWidth > node.clientWidth
        if (scrollsX) return true
        node = node.parentElement
      }
      return false
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length !== 1 || isExcluded(e.target)) {
        touch.active = false
        return
      }
      touch.active = true
      touch.startX = e.touches[0].clientX
      touch.startY = e.touches[0].clientY
    }

    function onTouchEnd(e: TouchEvent) {
      if (!touch.active) return
      touch.active = false

      const endTouch = e.changedTouches[0]
      const dx = endTouch.clientX - touch.startX
      const dy = endTouch.clientY - touch.startY
      if (Math.abs(dx) < SWIPE_MIN_DISTANCE) return
      if (Math.abs(dx) < Math.abs(dy) * SWIPE_DOMINANCE_RATIO) return

      const index = LINKS.findIndex((l) => l.href === pathname)
      if (index === -1) return
      // 왼쪽으로 밀기(dx < 0) = 다음 탭, 오른쪽으로 밀기(dx > 0) = 이전 탭.
      const nextIndex = dx < 0 ? index + 1 : index - 1
      const next = LINKS[nextIndex]
      if (next) router.push(next.href)
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }, [router, pathname])

  // min-w-0: body가 flex-col이라 이 div가 flex item이 된다. 기본값(min-width: auto)이면
  // 안의 넓은 표(overflow-x-auto)가 이 박스 자체를 옆으로 늘려버린다 — 실측 확인된 문제
  // (frontend/AGENTS.md, app/page.tsx 주석 참고). w-full만으로는 부모가 이미 넓어진
  // 뒤라 소용없어서, 늘어나는 원인 쪽인 이 컨테이너에 직접 걸어야 한다.
  return (
    <div ref={containerRef} className="min-w-0">
      {children}
    </div>
  )
}
