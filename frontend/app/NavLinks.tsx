'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LinkPendingSpinner } from '@/components/LinkPendingSpinner'

const LINKS = [
  { href: '/', label: '부동산' },
  { href: '/pullback', label: '눌림목 종목' },
  { href: '/discover', label: '종목 발굴' },
  { href: '/positions', label: '보유 종목 점검' },
  { href: '/history', label: '스크리너 성적' },
]

export function NavLinks() {
  const pathname = usePathname()

  return (
    <>
      {LINKS.map(({ href, label }) => {
        const active = pathname === href
        return (
          <Link
            key={href}
            href={href}
            className={`relative shrink-0 rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition-colors ${
              active
                ? 'bg-accent font-bold text-accent-foreground'
                : 'bg-secondary font-medium text-secondary-foreground hover:bg-border'
            }`}
          >
            {label}
            {/* absolute 배치 — 인라인으로 두면 보이지 않을 때도 오른쪽에 폭을 차지해
                텍스트가 버튼 중앙에서 왼쪽으로 밀린다 (레이아웃에서 완전히 뺀다). */}
            <LinkPendingSpinner className="absolute top-1/2 right-1.5 size-3 -translate-y-1/2" />
          </Link>
        )
      })}
    </>
  )
}
