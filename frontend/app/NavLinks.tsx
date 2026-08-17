'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/', label: '눌림목 종목' },
  { href: '/discover', label: '종목 발굴' },
  { href: '/history', label: '추천 이력' },
  { href: '/positions', label: '보유 종목 점검' },
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
            className={`text-sm transition-colors break-keep ${
              active
                ? 'border-b-2 border-foreground pb-0.5 font-bold text-foreground'
                : 'font-medium text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </Link>
        )
      })}
    </>
  )
}
