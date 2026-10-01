import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { NavLinks } from "./NavLinks";
import { ScrollButtons } from "@/components/ScrollButtons";
import { DailyAlertPopup } from "@/components/DailyAlertPopup";
import "./globals.css";

// 본문 폰트는 globals.css의 --font-sans(Pretendard self-host)가 담당한다.
// Geist는 latin subset만 받아 한글이 시스템 폰트로 떨어졌고, --font-sans에
// 연결돼 있지도 않아 실제로 적용되지 않던 상태였다.
// 등락률·가격처럼 자릿수를 맞춰야 하는 표(PerformanceTable 등)에서 font-mono를 쓴다.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "김한수의 보물지도",
  description: "한국/미국 시장 분위기와 주도섹터, 눌림목 매수 종목을 매일 보여주는 대시보드",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background">
        <header className="sticky top-0 z-10 border-b bg-card/95 backdrop-blur-sm">
          <nav className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2.5">
            {/* 제목을 두 줄로 접어 탭 줄에 가로 폭을 더 내준다 — 탭이 6개로 늘면서
                좁은 폰(320px)에서 마지막 탭(스크리너 성적)이 살짝 잘려 보이던 문제. */}
            <span className="shrink-0 text-sm leading-tight font-bold tracking-tight text-foreground">
              김한수의
              <br />
              보물지도
            </span>
            <div className="flex items-center gap-1.5 overflow-x-auto py-0.5 pr-1">
              <NavLinks />
            </div>
          </nav>
        </header>
        {/* min-w-0은 지우지 말 것 — body가 flex-col이라 이 div가 flex item이 되는데,
            기본값(min-width: auto)이면 안의 넓은 표(overflow-x-auto)가 이 박스를 옆으로
            늘려 페이지 전체가 가로로 넘친다(실측 확인, frontend/AGENTS.md·docs/ui-guide.md).
            w-full만으로는 부모가 이미 넓어진 뒤라 소용없어서 여기에 직접 건다.
            **원래 SwipeNavigation 컴포넌트가 이 역할을 겸하고 있었다** — 좌우 스와이프로
            탭을 넘기는 기능은 2026-10-01에 뺐지만(사용자: "은근 불편하네") 이 래퍼는
            그 기능과 무관하므로 남긴다. */}
        <div className="min-w-0">{children}</div>
        <ScrollButtons />
        <DailyAlertPopup />
      </body>
    </html>
  );
}
