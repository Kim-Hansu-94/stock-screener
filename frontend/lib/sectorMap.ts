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

// US GICS 대분류를 한글 대분류로 바로 매핑
const US_BROAD: Record<string, string> = {
  Technology: '기술',
  'Information Technology': '기술',
  'Communication Services': '커뮤니케이션',
  'Health Care': '헬스케어',
  Healthcare: '헬스케어',
  Financials: '금융',
  Finance: '금융',
  'Consumer Discretionary': '임의소비재',
  'Consumer Staples': '필수소비재',
  Industrials: '산업재',
  Energy: '에너지',
  Utilities: '유틸리티',
  'Real Estate': '부동산',
  Materials: '소재',
}

const has = (s: string, ...ks: string[]) => ks.some((k) => s.includes(k))

/**
 * 세분화된 업종(KOSPI KRX Industry ~130종, US GICS)을 12개 대분류로 축약한다.
 * 규칙 순서가 중요하다: 더 구체적/우선하는 분류를 앞에 둔다.
 */
export function broadSector(sector: string | null | undefined): string {
  if (!sector) return '미분류'
  if (US_BROAD[sector]) return US_BROAD[sector]
  const s = sector
  if (has(s, '부동산', 'Real Estate')) return '부동산'
  if (has(s, '금융', '은행', '저축기관', '보험', '신탁', '집합투자', '증권', '캐피탈', '자산운용', '상품 중개', 'Financ', 'Bank', 'Insurance', 'Invest'))
    return '금융'
  if (has(s, '의약', '의료', '바이오', '진단', '생명과학', '기초 의약', 'Health', 'Pharma', 'Biotech', 'Medical', 'Drug'))
    return '헬스케어'
  if (has(s, '반도체', '전자부품', '전자 부품', '컴퓨터', '소프트웨어', '프로그래밍', '시스템 통합', '통신 및 방송 장비', '영상 및 음향', '정밀기기', '측정', '광학', '디스플레이', '정보기술', '연구개발', 'Semiconductor', 'Software', 'Computer', 'EDP', 'Technolog', 'Electronic'))
    return '기술'
  if (has(s, '전기 통신', '통신업', '방송업', '텔레비전', '영화', '비디오', '방송프로그램', '오디오물', '광고', '출판', '포털', '자료처리', '호스팅', '정보 서비스', '오락', '창작', '예술', '스포츠 서비스', '기록매체', 'Media', 'Telecom', 'Advertis', 'Entertain', 'Publish'))
    return '커뮤니케이션'
  if (has(s, '연료용 가스', '배관공급', '수도사업', '증기, 냉', '전기업', 'Utilit')) return '유틸리티'
  if (has(s, '석유 정제', '원유', '석탄', '천연가스', '가스 채굴', 'Energy', 'Oil', 'Petroleum')) return '에너지'
  if (has(s, '기계', '건설', '건축', '엔지니어링', '운송', '물류', '조선', '선박', '보트', '항공', '전동기', '발전기', '케이블', '절연선', '구조용 금속', '공사업', '산업용', '중공업', '전기장비', '전구', '조명', '전지', '무기', '총포탄', '무역', '도매', '장비 임대', '포장', '인쇄', '컨설팅', '회사 본부', '사업지원', '사업시설', '유지·관리', '경비', '경호', '탐정', '시장조사', '여론조사', '디자인', '과학 및 기술 서비스', '과학기술 서비스', '전문 서비스', '폐기물', '재생', '해체', 'Aerospace', 'Industrial', 'Machinery', 'Military', 'Defense', 'Transport'))
    return '산업재'
  if (has(s, '화학', '철강', '비철금속', '금속', '시멘트', '석회', '플라스터', '플라스틱', '고무', '종이', '판지', '펄프', '골판지', '유리', '요업', '비금속 광물', '비료', '농약', '화학섬유', '도료', '목재', '제재', '나무제품', 'Materials', 'Chemical', 'Steel', 'Metal', 'Paper'))
    return '소재'
  if (has(s, '자동차', '의복', '봉제', '직물', '의류', '섬유', '소매', '가구', '가죽', '가방', '장신', '귀금속', '백화점', '호텔', '숙박', '레저', '유원지', '여행', '음식점', '교육', '교습', '학원', '화장품', '완구', '신발', '악기', '운동', '경기용구', '가정용', '방적', '수리업', '개인 서비스', '판매', 'Retail', 'Apparel', 'Auto', 'Catalog', 'Distribution', 'Consumer Disc'))
    return '임의소비재'
  if (has(s, '식품', '음료', '곡물', '수산', '농산', '담배', '음식료', '주류', '알코올', '전분', '사료', '낙농', '육류', '도축', '과실', '채소 가공', '떡', '빵', '과자', '조리식품', '작물', '재배', '어업', '어로', 'Food', 'Beverage', 'Soft Drink', 'Tobacco', 'Staples'))
    return '필수소비재'
  return '기타'
}
