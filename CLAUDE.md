# 보물지도 (stock-screener) — 구조 지도

작업 시작 전에 이 문서로 "어디에 뭐가 있는지"부터 찾을 것. 특히 `frontend/lib/queries.ts`는
855줄짜리 단일 파일이라 무작정 읽지 말고, 아래 표로 필요한 함수만 찾아서 Grep/Read.

## 전체 구조 (데이터 흐름)

```
pipeline/ (Python)              supabase/ (Postgres)        frontend/ (Next.js)
  GitHub Actions로 매일 실행  →   9개 테이블에 저장      →   queries.ts가 읽어서
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
| `fundamentals.py` | 실적(매출·이익) 수집 → `stock_fundamentals`. 종목당 API 호출이라 30일 주기 + 실행당 상한 |
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
| `queries.ts` (855줄) | **모든 Supabase 조회 함수.** 도메인 안 나뉘어 있음 — 아래 함수명으로 Grep해서 필요한 것만 읽을 것 |
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

`queries.ts` 함수 → 어느 화면에서 쓰는지:

| 함수 | 화면 |
|---|---|
| `getLatestRegime` / `getLeadingSectors` / `getScreenedStocks` / `getPriceHistoryByTicker` | 홈 (`app/page.tsx`) |
| `getWatchlistStatus` | 홈 감시 카드 |
| `getOpportunitySnapshot` / `getLongMonthlyHistory` / `getFundamentals` / `getUniverseMarketCaps` | 종목발굴 → 횡보·조정 (`app/discover/page.tsx`) |
| `getUniverseStocks` / `getUniverseNameMap` | 유니버스 메타 조회 (여러 곳에서 공용) |
| `getMonthlyPriceHistory` | 오늘의 추천 (`api/daily-report`) |
| `getScreenedStockPerformance` / `getExitSignals` / `getScreenerTrackRecord` / `getPullbackScreenerWithRisk` | 성적표(`history`)·포지션(`positions`) 페이지 |
| `fetchUsdKrwRate` | 미장 원화 환산 (여러 곳에서 공용) |

## frontend/app/ — 페이지별 역할

| 경로 | 내용 |
|---|---|
| `page.tsx` | 홈 — 감시 종목 카드 + 한국/미국 눌림목 스크리닝 |
| `discover/` | 종목발굴 — 오늘의 추천(패턴유사도) / 패턴검색 / 횡보·조정(사전계산) 3탭 |
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

## 작업 시 주의할 동기화 지점

- **눌림목 추세 게이트**: `pipeline/src/screener.py`(long_term_up) ↔ `frontend/lib/risk.ts`(trendStatus) — 동일 로직이어야 손익비 표시가 스크리닝 결과와 안 어긋남
- **횡보·조정 채점**: `frontend/lib/opportunityScore.ts`(참조) ↔ `pipeline/src/watchlist.py` · `pipeline/src/opportunities.py`(실제 실행) — 상수 하나도 따로 안 놀아야 함
- **조정폭 밴드**: `MIN_DRAWDOWN`/`MAX_DRAWDOWN` 원본은 `watchlist.py`. `opportunities.py`는 여기서 import해서 쓰지만, `fundamentals.py`(`_candidates_first`)는 **독립적으로 재정의**돼 있어 둘이 어긋날 수 있음 — 바꿀 땐 두 곳 다 확인

## 알려진 이슈

- `sp500_daily` 테이블 미생성 — S&P500 적립 탭 관련 파이프라인 단계가 매 실행 조용히 스킵됨
