'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import capitalSigungu from '@/lib/data/capital-sigungu.json'
import { formatManwon, priceMapColor, PRICE_SCALE_NO_DATA } from '@/lib/realestateTrend'
import type { RegionTrend } from '@/lib/realestateTrend'

const [VB_X, VB_Y, VB_W, VB_H] = capitalSigungu.viewBox.split(' ').map(Number)
const MIN_SCALE = 1
const MAX_SCALE = 10
// 클릭인지 드래그인지는 포인터가 눌린 뒤 움직인 거리로 가른다 — 화면 픽셀 기준
// (뷰박스 좌표는 확대 배율에 따라 같은 손가락 이동도 값이 달라져서 기준이 못 된다).
const DRAG_THRESHOLD_PX = 4

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 화면 좌표(clientX/Y) → SVG의 고정 viewBox 좌표. 확대(g의 transform)와 무관하게
 * <svg viewBox>는 자기 자신의 화면 박스 안에서 항상 같은 비율로 매핑된다. */
function toViewBoxPoint(rect: DOMRect, clientX: number, clientY: number) {
  return {
    x: VB_X + ((clientX - rect.left) / rect.width) * VB_W,
    y: VB_Y + ((clientY - rect.top) / rect.height) * VB_H,
  }
}

export function RealestateMap({ regions }: { regions: RegionTrend[] }) {
  const priceByCode = new Map<string, number>()
  for (const r of regions) {
    if (r.latest.price_avg != null) priceByCode.set(r.region_code, r.latest.price_avg)
  }
  const prices = [...priceByCode.values()]

  const svgRef = useRef<SVGSVGElement>(null)
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  // 드래그 상태는 리렌더가 필요 없어 ref로 들고 있는다.
  const drag = useRef({
    pointers: new Map<number, { x: number; y: number }>(),
    startDistance: 0, // 첫 포인터가 눌린 뒤 누적 이동 거리(px) — 클릭/드래그 판정용
    moved: false,
    pinchStartDist: null as number | null,
    pinchStartScale: 1,
    pressedHref: null as string | null,
  })

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const p = toViewBoxPoint(rect, clientX, clientY)
    setView((v) => {
      const newScale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE)
      // p가 현재 화면 위 같은 지점에 그대로 남도록 x/y를 다시 푼다.
      // (화면 위 점 p는 항상 translate(x,y) + scale*원본좌표 로 표현되므로,
      // 지금 배율에서 p 아래 있는 원본좌표를 구했다가 새 배율로 다시 앉힌다.)
      const ox = (p.x - v.x) / v.scale
      const oy = (p.y - v.y) / v.scale
      return { scale: newScale, x: p.x - newScale * ox, y: p.y - newScale * oy }
    })
  }, [])

  // 휠 줌은 페이지 스크롤을 막아야(preventDefault) 하는데, React가 JSX onWheel에
  // 다는 리스너는 브라우저 스크롤 성능을 위해 기본이 passive라 preventDefault가
  // 조용히 무시된다(콘솔에 경고만 남고 페이지가 같이 스크롤된다). addEventListener로
  // 직접 non-passive로 달아야 한다.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    function handleWheel(e: WheelEvent) {
      e.preventDefault()
      const factor = Math.exp(-e.deltaY * 0.0015)
      zoomAt(e.clientX, e.clientY, factor)
    }
    svg.addEventListener('wheel', handleWheel, { passive: false })
    return () => svg.removeEventListener('wheel', handleWheel)
  }, [zoomAt])

  // 훅은 전부 위에서 무조건 호출했으니 이제서야 조기 반환해도 안전하다.
  if (prices.length === 0) return null
  const min = Math.min(...prices)
  const max = Math.max(...prices)

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    // setPointerCapture로 드래그 중 포인터가 svg 밖으로 나가도 계속 받는데, 그 순간부터
    // 이후 이벤트(click 포함)의 target이 눌린 지역이 아니라 캡처한 svg로 바뀐다.
    // 그러면 <a>의 기본 이동이 아예 안 일어나므로, 눌린 시점의 진짜 대상(a의 href)을
    // 미리 기억해 뒀다가 onClickCapture에서 우리가 직접 이동시킨다.
    drag.current.pressedHref = (e.target as Element).closest('a')?.getAttribute('href') ?? null
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (drag.current.pointers.size === 1) {
      drag.current.moved = false
      drag.current.startDistance = 0
    }
    if (drag.current.pointers.size === 2) {
      const [a, b] = [...drag.current.pointers.values()]
      drag.current.pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y)
      drag.current.pinchStartScale = view.scale
    }
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!drag.current.pointers.has(e.pointerId)) return
    const prev = drag.current.pointers.get(e.pointerId)!
    drag.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (drag.current.pointers.size === 2 && drag.current.pinchStartDist != null) {
      const [a, b] = [...drag.current.pointers.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const midX = (a.x + b.x) / 2
      const midY = (a.y + b.y) / 2
      const targetScale = clamp(
        (drag.current.pinchStartScale * dist) / drag.current.pinchStartDist,
        MIN_SCALE,
        MAX_SCALE,
      )
      zoomAt(midX, midY, targetScale / view.scale)
      drag.current.moved = true
      return
    }

    if (drag.current.pointers.size !== 1) return
    const dx = e.clientX - prev.x
    const dy = e.clientY - prev.y
    drag.current.startDistance += Math.hypot(dx, dy)
    // 눌린 뒤 누적 이동이 임계값을 넘어야 "드래그"로 본다 — 안 그러면 살짝 떨리는
    // 클릭도 지역 이동으로 잡아먹혀 링크가 거의 안 눌린다.
    if (drag.current.startDistance > DRAG_THRESHOLD_PX) drag.current.moved = true

    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const dxVb = (dx / rect.width) * VB_W
    const dyVb = (dy / rect.height) * VB_H
    setView((v) => ({ ...v, x: v.x + dxVb, y: v.y + dyVb }))
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    drag.current.pointers.delete(e.pointerId)
    drag.current.pinchStartDist = null
  }

  function onClickCapture(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    // pointerCapture 탓에 이 click은 항상 svg를 target으로 재발화되어 <a>의 기본
    // 이동이 원래 일어나지 않는다(브라우저 자체 동작) — 그래서 직접 이동시킨다.
    // 단, 드래그였다면(지도를 옮기려던 것) 이동하지 않는다.
    const href = drag.current.pressedHref
    const wasDrag = drag.current.moved
    drag.current.moved = false
    drag.current.pressedHref = null
    if (href && !wasDrag) window.location.href = href
  }

  function zoomButton(factor: number) {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
  }

  function reset() {
    setView({ scale: 1, x: 0, y: 0 })
  }

  return (
    <div>
      <div className="relative" onClickCapture={onClickCapture}>
        <svg
          ref={svgRef}
          viewBox={capitalSigungu.viewBox}
          className="mx-auto block aspect-square w-full max-w-2xl touch-none rounded-lg bg-muted/40 select-none [&_path]:transition-opacity [&_path:hover]:opacity-70"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
            {capitalSigungu.regions.map((r) => {
              const price = priceByCode.get(r.region_code)
              const fill = price != null ? priceMapColor(price, min, max) : PRICE_SCALE_NO_DATA
              // <title>은 React 19에서 <head>로 끌어올릴 수 있는 특수 태그라, children이
              // 표현식 두 개(배열)면 안 되고 문자열 하나여야 한다 — 안 그러면 서버는
              // 500, 클라이언트는 하이드레이션 불일치로 깨진다.
              const tooltip = `${r.region_name}${price != null ? ` — ${formatManwon(price)}` : ' — 데이터 없음'}`
              return (
                <a key={r.region_code} href={`/realestate?region=${r.region_code}`}>
                  {/* non-scaling-stroke: 확대해도 경계선이 굵어지지 않고 항상 화면 기준
                      같은 두께로 남는다. 라벨 글자는 반대로 확대할수록 커져야
                      촘촘한 서울 자치구까지 읽히므로 그대로 g의 scale을 따라간다. */}
                  <path d={r.d} fill={fill} stroke="#fff" strokeWidth={0.5} vectorEffect="non-scaling-stroke">
                    <title>{tooltip}</title>
                  </path>
                  <text
                    x={r.cx}
                    y={r.cy}
                    textAnchor="middle"
                    fontSize={5.5}
                    fill="#191f28"
                    stroke="#fff"
                    strokeWidth={0.8}
                    paintOrder="stroke"
                    pointerEvents="none"
                  >
                    {r.region_name.replace(/^(서울|인천)\s/, '')}
                  </text>
                </a>
              )
            })}
          </g>
        </svg>
        <div className="absolute top-2 right-2 flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          <button
            type="button"
            onClick={() => zoomButton(1.4)}
            aria-label="확대"
            className="flex h-8 w-8 items-center justify-center text-base font-semibold text-foreground hover:bg-muted"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => zoomButton(1 / 1.4)}
            aria-label="축소"
            className="flex h-8 w-8 items-center justify-center border-t border-border text-base font-semibold text-foreground hover:bg-muted"
          >
            −
          </button>
          <button
            type="button"
            onClick={reset}
            aria-label="초기 화면"
            className="flex h-8 w-8 items-center justify-center border-t border-border text-[10px] font-medium text-muted-foreground hover:bg-muted"
          >
            ⟲
          </button>
        </div>
      </div>
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
        · 휠/핀치로 확대, 드래그로 이동
      </p>
    </div>
  )
}
