'use client'

import { useEffect, useState } from 'react'

// 페이지가 길 때만 오른쪽 아래에 맨위/맨아래 이동 버튼을 띄운다.
export function ScrollButtons() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const check = () => {
      setVisible(document.documentElement.scrollHeight > window.innerHeight * 1.5)
    }
    check()
    window.addEventListener('resize', check)
    // 카드 펼침 등으로 페이지 높이가 바뀌는 경우 감지
    const observer = new ResizeObserver(check)
    observer.observe(document.body)
    return () => {
      window.removeEventListener('resize', check)
      observer.disconnect()
    }
  }, [])

  if (!visible) return null

  const buttonClass =
    'flex h-10 w-10 items-center justify-center rounded-full border border-gray-200 bg-white/90 text-gray-500 shadow-md backdrop-blur-sm transition-colors hover:bg-gray-100 hover:text-gray-900'

  return (
    <div className="fixed bottom-5 right-4 z-20 flex flex-col gap-2 sm:right-6">
      <button
        type="button"
        aria-label="맨 위로"
        className={buttonClass}
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="맨 아래로"
        className={buttonClass}
        onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
        </svg>
      </button>
    </div>
  )
}
