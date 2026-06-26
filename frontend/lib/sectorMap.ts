const SECTOR_KO: Record<string, string> = {
  Technology: '기술',
  'Information Technology': '정보기술',
  'Health Care': '헬스케어',
  Healthcare: '헬스케어',
  Financials: '금융',
  Finance: '금융',
  'Consumer Discretionary': '임의소비재',
  'Consumer Staples': '필수소비재',
  'Communication Services': '커뮤니케이션',
  Industrials: '산업재',
  Energy: '에너지',
  Utilities: '유틸리티',
  'Real Estate': '부동산',
  Materials: '소재',
}

export function translateSector(sector: string | null | undefined): string {
  if (!sector) return '-'
  return SECTOR_KO[sector] ?? sector
}
