import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NavLinks } from "./NavLinks";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-gray-50">
        <header className="sticky top-0 z-10 border-b bg-white/95 backdrop-blur-sm">
          <nav className="mx-auto flex max-w-3xl items-center gap-6 px-4 py-3">
            <span className="text-sm font-bold tracking-tight text-gray-900">김한수의 보물지도</span>
            <NavLinks />
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
