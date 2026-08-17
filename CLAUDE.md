# 보물지도 (stock-screener) — 구조 지도

작업 시작 전에 이 문서로 "어디에 뭐가 있는지"부터 찾을 것. 특히 `frontend/lib/queries/`는
화면별로 나뉜 5개 파일이니, 무작정 다 읽지 말고 아래 표로 필요한 파일·함수만 찾아서 Grep/Read.

## 전체 구조 (데이터 흐름)

```
pipeline/ (Python)              supabase/ (Postgres)        frontend/ (Next.js)
  GitHub Actions로 매일 실행  →   9개 테이블에 저장      →   lib/queries/*가 읽어서
  (schema.sql)                                              페이지에 표시 (Vercel)
```

- 파이프라인 실행: `.github/workflows/pipeline.yml` (아침 전체 / 저녁 KR 전용)
- 배포: Vercel, `frontend/` 루트가 배포 단위
- 캐시: 프론트는 `'use cache'` + `SCREENER_CACHE_TAG`로 캐시, 파이프라인이 끝나면
  `/api/revalidate`가 무효화

## pipeline/src/ — 모듈별 역할

| 파일 | 역할 |
|---|---|
| `main.py` | 파이프라인 전체 오케스트레이션 (엔트리포인트, `python -m src.main [--kr-only]`) |
| `pipeline.py` | KR/US 스크리닝 실행 (`run_kr_pipeline` / `run_us_pipeline`), 눌림목 후보 선정 |
| `screener.py` | 눌림목 조건 평가 (`evaluate_pullback`) — 9개 CRITERION_* 판정 |
| `universe_kr.py` / `universe_us.py` | KOSPI / S&P1500+NASDAQ100+Russell3000 유니버스 수집 |
| `prices_kr.py` | FinanceDataReader로 국장 일봉 조회 |
| `prices_us.py` | yfinance/KIS로 미장 일봉·시총·환율 조회, 파일 캐시 |
| `kis_auth.py` | 한국투자증권 OAuth 토큰 관리 (분당 1회 제한이라 디스크 캐싱) |
| `indicators.py` | SMA·RSI·거래량비율 등 순수 계산 함수 |
| `sectors.py` | 주도 섹터 판정 |
| `market_regime.py` | 상승장/하락장 판정 |
| `opportunities.py` | 횡보·조정 후보 사전 계산 → `opportunity_snapshot` (프론트가 재계산 안 하도록) |
| `watchlist.py` | 감시 종목(보유 종목) 평가 → `watchlist_status`. **채점 로직은 `frontend/lib/opportunityScore.ts`의 포팅본 — 상수 바꿀 때 반드시 같이 수정** |
| `fundamentals.py` | 실적(매출·이익) 수집 → `stock_fundamentals`. 종목당 API 호출이라 30일 주기 + 실행당 상한. KR은 `dart_fundamentals.py`, US는 yfinance로 분기 |
| `dart_fundamentals.py` | DART(전자공시) Open API로 국내 종목 실적 수집. `DART_API_KEY` 시크릿 필요 — 미설정이면 KR 실적 수집을 통째로 건너뜀(로그만 남기고 계속 진행) |
| `long_history.py` | 10년 월봉 수집 → `stock_long_monthly`. 과거 확정 구간이라 미시드 종목만 1회 |
| `split_guard.py` | 액면분할 등 소급 조정 감지 (증분 수집이 만드는 가짜 급락 방지) |
| `pattern_discovery.py` | Gold Standard 바닥 패턴 유사도 (오늘의 추천 탭) |
| `backfill_kr_opportunities.py` | KR 기회 종목 3년치 최초 백필용 스크립트 (1회성) |
| `sp500_monitor.py` | S&P500 적립 탭용 — **현재 `sp500_daily` 테이블 미생성 상태로 매 실행 조용히 실패 중** |
| `db.py` | Supabase 클라이언트 래퍼 (`ScreenerDB`), 모든 `save_*`/`upsert` 메서드 |

## supabase/schema.sql — 테이블별 용도

| 테이블 | 쓰는 곳 | 읽는 곳 |
|---|---|---|
| `market_regime` | main.py | 홈 상승장/하락장 배지 |
| `leading_sectors` | main.py | 홈 주도 섹터 |
| `screened_stocks` | main.py | 홈 눌림목 카드 |
| `stock_price_history` | main.py (3년치, 매주 자동 정리) | 손익비 계산, 차트 |
| `stock_universe` | main.py | 종목명·섹터·시총 매핑 |
| `stock_long_monthly` | long_history.py (10년, 거의 불변) | 10년 고점, 장기 하락 경고 |
| `opportunity_snapshot` | opportunities.py | 횡보·조정 탭 (사전 계산 결과) |
| `stock_fundamentals` | fundamentals.py | 실적 동반 하락 판정 |
| `watchlist_status` | watchlist.py | 홈 감시 종목 카드 |

**용량 관리**: `stock_price_history` 인덱스 부풀림 방지용 주간 자동 리인덱스 +
3년 초과분 자동 삭제가 `pg_cron`에 걸려 있음 (Supabase SQL Editor에서 `select * from cron.job`으로 확인).

## frontend/lib/ — 모듈별 역할

| 파일 | 역할 |
|---|---|
| `queries/shared.ts` | `SCREENER_CACHE_TAG`, `fetchUsdKrwRate`, `fetchPriceRowsPaged`(공용 페이지네이션 헬퍼) |
| `queries/screener.ts` | 홈 화면(`app/page.tsx`) 쿼리 — 눌림목 스크리너 + 감시 카드 |
| `queries/universe.ts` | 종목 유니버스(이름·섹터·시총) 메타 조회 — 여러 화면 공용 |
| `queries/opportunities.ts` | 종목발굴 탭 쿼리 — 오늘의 추천·횡보/조정·실적 |
| `queries/performance.ts` | 성적표(`history`)·포지션(`positions`) 페이지 쿼리 |
| `risk.ts` | 손절/목표가/손익비 계산 (`computeStopTarget`). 추세 종목(`trendFrame`) vs 횡보 종목(`rangeFrame`) 틀 분리 |
| `riskGrade.ts` | 손익비 색상 등급 기준 (틀별로 다름) |
| `opportunityScore.ts` | 횡보·조정 매력도 점수 **참조 구현** — 실제 채점은 `pipeline/src/watchlist.py`가 포팅해서 수행. 상수 바꿀 때 항상 같이 수정 |
| `buySignal.ts` | 매력도 점수 → 매수 등급(적극검토/매수검토/관망) 변환 |
| `longTermContext.ts` | 3년 월봉 + 10년 월봉 병합, 장기 고점/하락 판정 |
| `fundamentals.ts` | 실적 데이터 → 가치함정/밸류에이션조정 판정 |
| `similarity.ts` | 패턴 유사도 검색 (SimilaritySearch 탭용) |
| `sectorMap.ts` | 섹터명 한글 번역 |
| `calculations.ts` | 등락률·SMA·볼린저밴드 등 차트용 순수 계산 |
| `supabase.ts` | Supabase 클라이언트 생성 |
| `types.ts` (266줄) | 전체 타입 정의 |

`queries/*` 함수 → 어느 화면에서 쓰는지:

| 함수 | 파일 | 화면 |
|---|---|---|
| `getLatestRegime` / `getLeadingSectors` / `getScreenedStocks` / `getPriceHistoryByTicker` | `screener.ts` | 홈 (`app/page.tsx`) |
| `getWatchlistStatus` | `screener.ts` | 홈 감시 카드 |
| `getOpportunitySnapshot` / `getLongMonthlyHistory` / `getFundamentals` | `opportunities.ts` | 종목발굴 → 횡보·조정 (`app/discover/page.tsx`) |
| `getUniverseStocks` / `getUniverseNameMap` / `getUniverseMarketCaps` | `universe.ts` | 유니버스 메타 조회 (여러 곳에서 공용) |
| `getMonthlyPriceHistory` | `opportunities.ts` | 오늘의 추천 (`api/daily-report`) |
| `getScreenedStockPerformance` / `getExitSignals` / `getScreenerTrackRecord` / `getPullbackScreenerWithRisk` / `getRegimesInRange` | `performance.ts` | 성적표(`history`)·포지션(`positions`) 페이지 |
| `fetchUsdKrwRate` / `fetchPriceRowsPaged` | `shared.ts` | 미장 원화 환산 · 가격 이력 페이지네이션 (여러 곳에서 공용) |

## frontend/app/ — 페이지별 역할

| 경로 | 내용 |
|---|---|
| `page.tsx` | 홈 — 감시 종목 카드 + 한국/미국 눌림목 스크리닝 |
| `discover/` | 종목발굴 — 오늘의 추천(패턴유사도) / 패턴검색 / 횡보·조정(사전계산) 3탭. `DiscoverTabs.tsx`는 탭 전환 껍데기, 탭별 내용은 `DailyReport.tsx` / `SimilaritySearch.tsx` / `OpportunityTab.tsx`로 분리 |
| `history/` | 스크리닝 성적표 (과거 추천의 결과) |
| `positions/` | 보유 포지션 청산 신호 |
| `api/daily-report` | 오늘의 추천 API (Gold Standard 패턴 매칭) |
| `api/similar` | 패턴 유사도 검색 API |
| `api/stock-news` | 종목 뉴스 조회 |
| `api/revalidate` | 파이프라인이 갱신 후 캐시 무효화 호출 |

## frontend/components/

`StockCard.tsx`(홈 카드) · `StockChart.tsx`(lightweight-charts, lazy load) ·
`WatchlistCard.tsx`(감시 카드) · `PerformanceTable.tsx`/`ExitSignalTable.tsx`/`TrackRecordCard.tsx`
(성적표·포지션) · `LeadingSectors.tsx` · `MarketRegimeBadge.tsx`

## 디자인 시스템 (토스증권 문법)

- **색·폰트·라운드는 전부 `frontend/app/globals.css`의 토큰**에서 나온다. 카드마다 색을 직접
  고르지 말고 토큰을 쓸 것 (`--primary` #3182F6, `--destructive` #F04452, `--background` #F2F4F6).
- **등락 색은 한국 관례**: 상승=빨강 `--up`, 하락=파랑 `--down` (`text-up` / `text-down` 유틸리티).
  서양식(상승=초록)으로 쓰지 말 것.
- **본문 폰트는 Pretendard self-host**: `app/pretendard.css`(@font-face 92개, unicode-range 동적
  서브셋) + `public/fonts/pretendard/`. 브라우저가 화면에 쓰인 글자 구간만 받아 페이지당 약 75KB.
  `--font-sans`는 `:root`에 정의돼 있고 `@theme inline`이 그걸 참조한다 — **순서를 바꾸면 순환
  참조로 폰트가 죽으니** `:root` 정의가 `@theme` 뒤에 오는 구조를 유지할 것.
- `font-mono`(`--font-geist-mono`)는 자릿수를 맞춰야 하는 표에서만 쓴다.

## 작업 시 주의할 동기화 지점

- **눌림목 추세 게이트**: `pipeline/src/screener.py`(long_term_up) ↔ `frontend/lib/risk.ts`(trendStatus) — 동일 로직이어야 손익비 표시가 스크리닝 결과와 안 어긋남
- **횡보·조정 채점**: `frontend/lib/opportunityScore.ts`(참조) ↔ `pipeline/src/watchlist.py` · `pipeline/src/opportunities.py`(실제 실행) — 상수 하나도 따로 안 놀아야 함
- **조정폭 밴드**: `MIN_DRAWDOWN`/`MAX_DRAWDOWN` 원본은 `watchlist.py`. `opportunities.py`는 여기서 import해서 쓰지만, `fundamentals.py`(`_candidates_first`)는 **독립적으로 재정의**돼 있어 둘이 어긋날 수 있음 — 바꿀 땐 두 곳 다 확인

## 알려진 이슈

- `sp500_daily` 테이블 미생성 — S&P500 적립 탭 관련 파이프라인 단계가 매 실행 조용히 스킵됨
- `DART_API_KEY` 시크릿 미등록 — 등록 전까지 국내 종목 실적 수집이 매 실행 조용히 스킵됨
  (`dart_fundamentals.py`). GitHub 저장소 Settings → Secrets and variables → Actions에서
  등록하면 다음 실행부터 바로 채워짐
