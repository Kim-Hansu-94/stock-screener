'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  { href: '/', label: '눌림목 종목' },
  { href: '/discover', label: '종목 발굴' },
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
            className={`text-sm font-medium transition-colors ${
              active
                ? 'text-blue-600 border-b-2 border-blue-600 pb-0.5'
                : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            {label}
          </Link>
        )
      })}
    </>
  )
}
