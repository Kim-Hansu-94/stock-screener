import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { NavLinks } from "./NavLinks";
import { ScrollButtons } from "@/components/ScrollButtons";
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
          <nav className="mx-auto flex max-w-3xl items-center gap-6 px-4 py-3">
            <span className="text-sm font-bold tracking-tight text-foreground break-keep">김한수의 보물지도</span>
            <NavLinks />
          </nav>
        </header>
        {children}
        <ScrollButtons />
      </body>
    </html>
  );
}
