import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
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
  title: "눌림목 매수 스크리너",
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
      <body className="min-h-full flex flex-col">
        <header className="border-b bg-white">
          <nav className="mx-auto flex max-w-3xl items-center gap-6 px-4 py-3 text-sm font-medium">
            <Link href="/" className="text-gray-700 hover:text-blue-600">
              눌림목 종목
            </Link>
            <Link href="/discover" className="text-gray-700 hover:text-blue-600">
              종목 발굴
            </Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
