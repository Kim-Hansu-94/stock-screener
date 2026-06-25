# 주식 스크리너 프론트엔드 — 설계

상위 스펙: [`2026-06-25-stock-screener-design.md`](./2026-06-25-stock-screener-design.md) (특히 "프론트엔드" 섹션)의 구현 설계를 구체화한다. 데이터 파이프라인은 이미 동작 중이며(매일 08:30 KST GitHub Actions), 이 문서는 Supabase에 쌓인 데이터를 보여주는 Next.js 웹사이트의 구현 설계만 다룬다.

## 저장소 구조

- 같은 GitHub 저장소(`stock-screener`)에 `frontend/` 폴더로 둔다. `pipeline/`, `supabase/`와 나란히 위치.
- Vercel 프로젝트를 만들 때 Root Directory를 `frontend`로 지정한다 (사용자가 직접 Vercel 계정에 로그인해 연결).
- 파이프라인의 GitHub Actions 시크릿과는 별도로, Vercel 프로젝트 환경변수에도 `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`를 사용자가 직접 등록해야 한다.

## 아키텍처

- **Next.js 14+ (App Router)**, 단일 페이지 대시보드. 별도 라우팅 불필요 (1단계는 최신 날짜 데이터만 보여주고, 날짜별 히스토리 조회는 3단계 백테스팅과 함께 나중에 추가).
- 메인 페이지(`app/page.tsx`)는 **Server Component**이며 `export const dynamic = 'force-dynamic'`로 캐싱 없이 매 요청마다 Supabase를 조회한다. (트래픽이 적은 지인 공유용 사이트이므로 Vercel 무료 티어로 충분하고, 항상 최신 데이터를 보여주는 단순함을 우선한다.)
- Supabase 접속은 **service_role 키를 서버에서만** 사용한다. 클라이언트로 내려가는 코드/번들에는 절대 포함하지 않는다. 이는 파이프라인이 이미 service_role로 RLS를 우회하는 것과 동일한 권한 모델이므로, 프론트엔드를 위한 별도의 공개 read RLS 정책은 추가하지 않는다.
- 스타일링은 **Tailwind CSS + shadcn/ui** (Card, Badge 컴포넌트 등)를 사용해 적은 코드로 정돈된 UI를 만든다.
- 캔들차트는 **lightweight-charts** 라이브러리를 사용하는 Client Component. 데이터는 서버에서 이미 내려준 props를 그대로 쓰고, 별도의 클라이언트 fetch는 하지 않는다(아래 "차트 데이터" 참고).
- 배포: Vercel. GitHub 저장소 push 시 자동 배포. 연결 작업은 사용자가 직접 수행.

## 데이터 흐름

매 요청마다 `app/page.tsx`에서 한 번에:

1. `market_regime`에서 KR/US 각각 가장 최근 날짜(`date`) 한 행씩 조회 → 상승장/하락장 판단.
2. 그 날짜를 기준으로 `leading_sectors`(시장별 rank 순 3개)와 `screened_stocks`(같은 날짜, 같은 시장) 조회.
3. `screened_stocks`에 있는 모든 티커에 대해 `stock_price_history`에서 해당 종목의 전체 보유 기간(최대 120일) OHLCV를 한 번에 조회.
   - 등락률(%) = 가장 최근 두 거래일 종가 비교로 계산 (`(오늘 종가 - 전일 종가) / 전일 종가`).
   - 같은 데이터를 캔들차트(5/20/60일 이동평균 오버레이 + 거래량 바)에도 그대로 사용.
4. 위 데이터를 모두 합쳐 `StockCard`들에게 props로 내려준다. 카드 클릭 시 차트를 펼치는 것은 순수 클라이언트 상태(펼침/접힘) 전환일 뿐, 추가 네트워크 요청은 없다.

이렇게 하는 이유: 눌림목 필터를 통과하는 종목 수가 실제로 적다(검증 당시 미국 2개, 한국 0개). `stock_price_history`도 통과 종목에 대해서만 저장되므로 전체 데이터량이 작아, 지연 로딩(lazy loading)으로 얻는 이점이 거의 없고 오히려 API 라우트·로딩 상태·에러 처리 코드가 불필요하게 늘어난다. 따라서 한 번에 다 가져오는 단순한 방식을 택한다.

## 컴포넌트 구성

- `app/page.tsx` — 데이터 조회 + 전체 레이아웃 (Server Component)
- `lib/supabase.ts` — 서버 전용 Supabase 클라이언트 생성 (service_role 키, `import 'server-only'`로 클라이언트 번들 유입 방지)
- `lib/queries.ts` — 타입이 있는 조회 함수: `getLatestRegimes()`, `getLeadingSectors(date)`, `getScreenedStocks(date)`, `getPriceHistory(tickers)`
- `lib/calculations.ts` — 순수 함수: 등락률 계산, 빈 리스트 판정 등 (단위 테스트 대상)
- `components/MarketRegimeBadge.tsx` — 시장별 상승장/하락장 배지. 하락장이면 경고 색상 + 문구.
- `components/LeadingSectors.tsx` — 시장별 주도섹터 3개 리스트
- `components/StockCard.tsx` — Client Component. 종목명/티커/현재가/등락률/시가총액/섹터/RSI 표시, 클릭 시 펼침 상태 토글
- `components/StockChart.tsx` — Client Component. props로 받은 OHLCV로 lightweight-charts 렌더링 (이동평균 오버레이 + 거래량 바)

## 화면 구성 (모바일 반응형)

- 상단: KR/US 시장분위기 배지
- 그 아래: KR/US 각각 주도섹터 3개
- 그 아래: 눌림목 통과 종목 카드 리스트 (KR/US 구분), 종목이 0개면 안내 문구만 표시
- 카드 클릭 → 캔들차트 펼침

## 에러 처리

- 특정 시장의 `market_regime` 데이터가 아직 없는 경우(파이프라인 최초 실행 전 등) → 해당 시장 영역에 "데이터가 아직 없습니다" 표시
- 그날 통과 종목이 0개인 시장 → 시장분위기/주도섹터는 정상 표시, 종목 리스트 영역에만 "조건을 만족하는 종목이 없습니다" 안내
- 시장별 Supabase 조회를 독립적으로 try/catch하여, 한 시장의 조회 실패가 다른 시장 렌더링을 막지 않도록 한다. 실패한 시장에는 에러 메시지만 표시.
- 차트는 서버에서 이미 받은 데이터를 그대로 렌더링하므로 클라이언트 측 fetch 에러 케이스가 없다.

## 테스트 범위

지인 공유용 소규모 개인 대시보드이므로, 파이프라인 수준의 무거운 테스트 스위트는 두지 않는다.

- `lib/calculations.ts`의 순수 함수(등락률 계산, 빈 리스트 판정 등)만 Vitest 단위 테스트로 커버한다.
- UI/통합 동작은 개발 서버를 띄워 브라우저로 직접 확인한다 (E2E 스위트는 구축하지 않음).
- 사용자가 처음 시도해보는 스택이라 결과를 보고 추가 테스트나 수정이 필요하면 그때 추가한다.

## 범위 밖 (다음 단계로 분리)

- 날짜별 히스토리 조회/탐색 (3단계 백테스팅과 함께)
- 2단계 차트 패턴 유사도 검색 기능
- 인증/로그인 (계속 불필요 — 공개 URL 공유 방식 유지)
