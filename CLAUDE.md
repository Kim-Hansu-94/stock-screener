# 보물지도 (stock-screener) — 구조 지도

작업 시작 전에 이 문서로 "어디에 뭐가 있는지"부터 찾을 것. 특히 `frontend/lib/queries/`는
화면별로 나뉜 5개 파일이니, 무작정 다 읽지 말고 아래 표로 필요한 파일·함수만 찾아서 Grep/Read.

**알고리즘(스크리닝 조건·채점 공식·상수) 작업이면 `docs/algorithms.md`부터, UI/디자인
작업이면 `docs/ui-guide.md`부터 볼 것** — 소스를 처음부터 다시 읽지 않아도 되게 상수·공식·
패턴을 미리 정리해 둔 문서다. 이 구조 지도(CLAUDE.md)는 "어디에 뭐가 있는지", 그 둘은
"그 안에 정확히 뭐가 들어있는지"를 담당한다. 백테스트 규칙은 `docs/backtest-guide.md`.

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
| `screener.py` | 눌림목 조건 평가 (`evaluate_pullback`) — 8개 CRITERION_* 판정 |
| `universe_kr.py` / `universe_us.py` | KOSPI / S&P1500+NASDAQ100+Russell3000 유니버스 수집. `universe_us.py`의 NASDAQ100(stockanalysis.com)엔 업종 정보가 없어, S&P500에도 없는 NASDAQ100 전용 소수 종목은 `_backfill_missing_sectors`가 yfinance로 보완(실패해도 그 종목만 '미분류'로 남고 파이프라인은 계속). yfinance의 업종 이름이 GICS 표준과 4개 다른데(Consumer Cyclical/Defensive, Financial Services, Basic Materials) `frontend/lib/sectorMap.ts`의 `broadSector()`는 GICS 이름 기준이라, `_YFINANCE_SECTOR_TO_GICS`로 저장 전에 정규화한다 — 안 하면 그 업종 종목만 '기타'로 조용히 잘못 분류된다 |
| `prices_kr.py` | FinanceDataReader로 국장 일봉 조회 |
| `prices_us.py` | yfinance/KIS로 미장 일봉·시총·환율 조회, 파일 캐시 |
| `kis_auth.py` | 한국투자증권 OAuth 토큰 관리 (분당 1회 제한이라 디스크 캐싱) |
| `indicators.py` | SMA·RSI·거래량비율 등 순수 계산 함수 |
| `sectors.py` | 주도 섹터 판정 |
| `market_regime.py` | 상승장/하락장 판정 |
| `opportunities.py` | 횡보·조정 후보 사전 계산 → `opportunity_snapshot` (프론트가 재계산 안 하도록). `in_band_tickers()`(조정폭 20~60% 판정)는 `fundamentals.py`도 대상 종목을 좁히는 데 재사용 |
| `watchlist.py` | 감시 종목(보유 종목) 평가 → `watchlist_status`. **채점 로직은 `frontend/lib/opportunityScore.ts`의 포팅본 — 상수 바꿀 때 반드시 같이 수정** |
| `fundamentals.py` | 실적(매출·이익) 수집 → `stock_fundamentals`. `main.py`가 유니버스 전체가 아니라 `in_band_tickers()`로 좁힌 조정폭 밴드 종목만 넘김(밴드 밖은 화면에 안 뜨므로). 30일 주기 + 실행당 상한. KR은 `dart_fundamentals.py`, US는 yfinance로 분기 |
| `dart_fundamentals.py` | DART(전자공시) Open API로 국내 종목 실적 수집. `DART_API_KEY` 시크릿 필요 — 미설정이면 KR 실적 수집을 통째로 건너뜀(로그만 남기고 계속 진행). 우선주는 DART corpCode.xml에 자기 종목코드가 없어 이름에서 "우"/"N우B" 접미사를 떼어 보통주 corp_code로 대신 조회함(재무제표는 법인 단위라 회계적으로 문제없음) — 이름 매핑은 `main.py`가 KR 유니버스 전체에서 만들어 넘김. 손익 계정과 같은 API 응답(`fnlttSinglAcnt.json`)에 대차대조표 주요계정도 들어 있어, 재무건전성(유동자산·유동부채·부채총계·자본총계)도 추가 호출 없이 같이 뽑는다(2026-09-02) |
| `us_financial_health_main.py` | US 종목 재무건전성(대차대조표) 전용 수집 — 실적(`fundamentals.py`의 income_stmt)과 별도 낮은 빈도(21:00 KST, 같은 30일 주기)로 독립 실행. yfinance는 대차대조표가 손익계산서와 별도 호출이라 종목당 요청이 두 배가 되므로 매일 도는 본 파이프라인에 얹지 않음. 유니버스는 재수집하지 않고 그날 아침 본 파이프라인이 저장해 둔 `stock_universe`를 그대로 읽는다(`ScreenerDB.get_universe_tickers`). `stock_fundamentals.financial_health_updated_at`으로 실적용 `updated_at`과 신선도를 분리 추적 — 같은 컬럼을 쓰면 재무건전성만 갱신해도 "실적도 최근 갱신됐다"고 착각해 진짜 실적 갱신을 건너뛰게 된다. 별도 워크플로(`.github/workflows/us_financial_health.yml`) + 별도 pg_cron(`supabase/pg_cron_us_financial_health_trigger.sql`, 매일 21:00 KST) |
| `long_history.py` | 10년 월봉 수집 → `stock_long_monthly`. 과거 확정 구간이라 미시드 종목만 1회 |
| `split_guard.py` | 액면분할 등 소급 조정 감지 (증분 수집이 만드는 가짜 급락 방지) |
| `pattern_discovery.py` | Gold Standard 바닥 패턴 유사도 (저점 매집 후보 탭, 구 "오늘의 추천") |
| `db.py` | Supabase 클라이언트 래퍼 (`ScreenerDB`), 모든 `save_*`/`upsert` 메서드 |
| `realestate.py` / `realestate_main.py` / `lawd_codes.py` | 부동산 실거래 동향 (국토부 Open API). **주식 파이프라인과 분리된 별도 워크플로**(`.github/workflows/realestate.yml`, 주 1회) — 실거래는 신고 기한이 30일이라 매일 볼 이유가 없고, 여기가 실패했다고 주식 스크리닝이 죽으면 안 된다. `MOLIT_API_KEY` 필요 (미설정이면 조용히 건너뜀) |
| `realestate_media.py` / `realestate_media_main.py` | 부동산 관련 뉴스(네이버 뉴스검색 API)·유튜브(YouTube Data API) 링크 수집 — 홈 상단 노출용. **또 다른 별도 워크플로**(`.github/workflows/realestate_media.yml`, 매일 1회) — 실거래(주 1회)·주식 파이프라인과 모두 독립. 날짜별 이력을 안 쌓고 매 실행마다 테이블을 통째로 갈아끼우는 "오늘의 스냅샷"이다(어제 뉴스를 보여줄 이유가 없다). `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET`, `YOUTUBE_API_KEY` 필요 — 하나만 없으면 그 소스만 건너뛰고, 둘 다 없으면 실행 자체가 에러로 멈춘다(안 그러면 초록불로 끝나 "다 됐다"로 보임) |

## supabase/schema.sql — 테이블별 용도

| 테이블 | 쓰는 곳 | 읽는 곳 |
|---|---|---|
| `market_regime` | main.py | 눌림목 종목 탭 상승장/하락장 배지 |
| `leading_sectors` | main.py | 눌림목 종목 탭 주도 섹터 |
| `screened_stocks` | main.py | 눌림목 종목 탭 카드 |
| `stock_price_history` | main.py (600일치, 매주 자동 정리) | 손익비 계산, 차트 |
| `stock_universe` | main.py | 종목명·섹터·시총 매핑 |
| `stock_long_monthly` | long_history.py (10년 시드) + `accrue_long_monthly()`(매 실행, 확정 월봉 적립) | 10년 고점, 장기 하락 경고, **3년 고점의 600일 이전 구간** |
| `opportunity_snapshot` | opportunities.py | 횡보·조정 탭 (사전 계산 결과) |
| `stock_fundamentals` | fundamentals.py(실적) + us_financial_health_main.py(US 재무건전성) | 실적 동반 하락 판정 + 재무건전성(유동비율·부채비율, KR·US) |
| `watchlist_status` | watchlist.py | 눌림목 종목 탭 감시 종목 카드 |
| `realestate_monthly` | realestate_main.py (주 1회) | 부동산 동향 탭 (`supabase/realestate.sql`로 생성). PK에 `area_band` 포함 — `ALL`(구 전체) + 면적 4구간 |
| `realestate_media` | realestate_media_main.py (매일 1회, 매 실행마다 전체 갈아끼움) | 부동산 동향 탭 홈 상단 뉴스·영상 (`supabase/realestate_media.sql`로 생성) |
| `paper_trades` | 사이트의 매수/매도 버튼 | 보유 종목 점검 탭 (`supabase/paper_trades.sql`로 생성) |
| `recommendation_history` | main.py (저점 매집 후보 추천 기록) | **아직 읽는 화면 없음** — 패턴 추천 성적을 낼 때 쓸 재료 |

**용량 관리**: Supabase 무료 플랜은 DB 500MB가 한도다. `stock_price_history`가 전체의 84%를
먹던 것을 두 가지로 줄였다 — (1) `close/high/low/volume`을 통째로 INCLUDE하던 인덱스를
`close` 전용으로 교체, (2) 일봉 보관을 3년 → **600일**로 축소. 600일인 이유는 일봉을 읽는 곳의
최대 요구치가 500일(`opportunities.py`의 `BARS_DAYS`)이기 때문. 600일 초과분 삭제는 `pg_cron`
잡 `trim-stock-price-history`가 매주 수행한다 (`select * from cron.job`으로 확인).

**"3년 고점"의 실제 창은 최근 36개월이다** — 월봉은 달 단위라 1095일 지점에서 자를 수 없어
`get_opp_drawdowns`가 3년 전이 속한 달을 통째로 포함한다(창이 최대 30일 길어짐). 그 달을 빼면
고점을 놓쳐 조정폭이 얕게 나오므로 포함하는 쪽을 택했다. 마이그레이션 직후 US 일부 종목에서
구 RPC 값과 몇 % 차이가 났던 것이 이 때문이며, 재계산 값이 더 높은 게 정상이다.

**3년 고점은 이제 "일봉 ∪ 월봉"에서 나온다** — 일봉이 600일뿐이라 그 이전 구간은
`stock_long_monthly.close_high`(그 달 일봉 종가의 최댓값)가 맡는다. `high`(장중 고가)나
`close`(월말 종가)로 대신하면 값이 어긋나므로 별도 컬럼이 필요했다. 마이그레이션 절차는
`supabase/monthly_01_backfill.sql` ~ `monthly_05_cron.sql`에 번호 순서대로 있다.

## frontend/lib/ — 모듈별 역할

| 파일 | 역할 |
|---|---|
| `queries/shared.ts` | `SCREENER_CACHE_TAG`, `fetchUsdKrwRate`, `fetchPriceRowsPaged`(공용 페이지네이션 헬퍼) |
| `queries/screener.ts` | 눌림목 종목 화면(`app/pullback/page.tsx`) 쿼리 — 눌림목 스크리너 + 감시 카드 |
| `queries/universe.ts` | 종목 유니버스(이름·섹터·시총) 메타 조회 — 여러 화면 공용 |
| `queries/opportunities.ts` | 종목발굴 탭 쿼리 — 저점 매집 후보·횡보/조정·실적 |
| `queries/performance.ts` | 스크리너 성적(`history`)·포지션(`positions`) 페이지 쿼리 |
| `queries/trades.ts` | 가상 매매장(`paper_trades`) 조회 — 보유/청산 포지션(매도 신호 포함), 열린 티커 집합 |
| `queries/realestate.ts` | 부동산 탭(`app/page.tsx`, 홈) 쿼리 — `realestate_monthly` 전체를 한 번에 받아 개요·상세를 둘 다 파생시킨다. `getRealestateMedia`(뉴스·영상)는 매일 갱신되는 데이터라 나머지(`cacheLife('hours')`)보다 짧게(`'minutes'`) 캐싱 |
| `realestateTrend.ts` | 부동산 원본 행 → 지역 목록(최신월+전월대비, 매매가 내림차순)·지역 상세(월별+전월대비)·지도 색상(`priceMapColor`, 매매가 → 단일색조 연속 스케일) 가공하는 순수 함수. `realestateTrend.test.ts`로 검증 |
| `data/capital-sigungu.json` | 수도권 77개 시군구 SVG 지도 좌표(사전 계산). 통계청 SGIS(2018, 공공누리 1유형) 경계를 `southkorea/southkorea-maps`에서 받아 LAWD_CD로 매핑하고 d3-geo로 투영해 만들었다(재현 스크립트는 저장 안 함 — 경계 자체가 거의 안 바뀌어 일회성). 옹진군은 원양 도서 때문에 투영 기준(fitSize)에서 뺐다 |
| `risk.ts` | 손절/목표가/손익비 계산 (`computeStopTarget`). 추세 종목(`trendFrame`) vs 횡보 종목(`rangeFrame`) 틀 분리 |
| `riskGrade.ts` | 손익비 색상 등급 기준 (틀별로 다름) |
| `scorecard.ts` | 스크리너 성적 집계 — 추천을 앞으로 걸어 목표/손절/기간만료로 판정하고 기댓값(R)·본전선·구간별 성과를 낸다. 순수 함수라 `scorecard.test.ts`로 검증 |
| `opportunityScore.ts` | 횡보·조정 매력도 점수 **참조 구현** — 실제 채점은 `pipeline/src/watchlist.py`가 포팅해서 수행. 상수 바꿀 때 항상 같이 수정 |
| `exitSignal.ts` | "이제 팔 때" 판정 — 진입일부터 하루씩 걸어 처음 걸린 날을 찾는다. **컨셉(`paper_trades.source`)에 따라 규칙이 갈린다**: 눌림목은 손절/목표 + 대량거래음봉·하락장·주도섹터이탈·60일선하회, 횡보·조정은 **가격만**(손절/목표 + 진입 시점 바닥 이탈). 횡보·조정 종목은 구조상 60일선 아래라 눌림목 규칙을 걸면 진입 다음 날 바로 신호가 뜬다. **신호 시점 가격을 저장하지 않고 매번 재현한다**(사이트에 안 들어온 날의 신호를 놓치지 않고, 기존 보유분에도 소급 적용) |
| `buySignal.ts` | 매력도 점수 → 매수 등급(적극검토/매수검토/관망) 변환 |
| `longTermContext.ts` | 3년 월봉 + 10년 월봉 병합, 장기 고점/하락 판정 |
| `fundamentals.ts` | 실적 데이터 → 가치함정/밸류에이션조정 판정 |
| `similarity.ts` | 패턴 유사도 검색 (SimilaritySearch 탭용) |
| `sectorMap.ts` | 섹터명 한글 번역 |
| `calculations.ts` | 등락률·SMA·볼린저밴드 등 차트용 순수 계산 |
| `supabase.ts` | Supabase 클라이언트 생성 |
| `types.ts` (255줄) | 전체 타입 정의 |

`queries/*` 함수 → 어느 화면에서 쓰는지:

| 함수 | 파일 | 화면 |
|---|---|---|
| `getLatestRegime` / `getLeadingSectors` / `getScreenedStocks` / `getPriceHistoryByTicker` | `screener.ts` | 눌림목 종목 (`app/pullback/page.tsx`) |
| `getWatchlistStatus` | `screener.ts` | 눌림목 종목 탭 감시 카드 |
| `getOpportunitySnapshot` / `getLongMonthlyHistory` / `getFundamentals` | `opportunities.ts` | 종목발굴 → 횡보·조정 (`app/discover/page.tsx`) |
| `getUniverseStocks` / `getUniverseNameMap` / `getUniverseMarketCaps` | `universe.ts` | 유니버스 메타 조회 (여러 곳에서 공용) |
| `getMonthlyPriceHistory` | `opportunities.ts` | 저점 매집 후보 (`api/daily-report`) |
| `getScorecardTrades` / `getScreenedStockPerformance` / `getExitSignals` / `getPullbackScreenerWithRisk` / `getRegimesInRange` | `performance.ts` | 스크리너 성적(`history`)·포지션(`positions`) 페이지 |
| `fetchUsdKrwRate` / `fetchPriceRowsPaged` | `shared.ts` | 미장 원화 환산 · 가격 이력 페이지네이션 (여러 곳에서 공용) |
| `getRealestateMonthly` / `getRealestateMedia` | `queries/realestate.ts` | 부동산 동향 (`app/page.tsx`, 홈) — 후자는 홈 상단 뉴스·영상 |

## frontend/app/ — 페이지별 역할

| 경로 | 내용 |
|---|---|
| `page.tsx` | **홈(`/`)** — 부동산 동향. 수도권 시군구별 아파트 매매·전월세 월간 집계. `?region=코드`로 지역 목록 ↔ 지역 상세(구간별 펼치기) 전환. 목록은 매매 평균가 내림차순 + 지도(`components/RealestateMap.tsx`, 매매가 색상 choropleth), 표시는 `components/RealestateTables.tsx`. 지역 목록(개요) 화면 최상단에는 `RealestateMediaSection.tsx`(관련 뉴스·유튜브, 지역과 무관한 전국 단위라 지역 상세 화면엔 없음). 탭 순서 개편(2026-08)으로 구 `realestate/`가 루트로, 구 홈은 `pullback/`로 이동 |
| `pullback/` | 눌림목 종목 — 감시 종목 카드 + 한국/미국 눌림목 스크리닝 (구 홈, 경로 `/pullback`) |
| `discover/` | 종목발굴 — 횡보·조정(사전계산) / 저점 매집 후보(패턴유사도, 구 "오늘의 추천") / 패턴검색 3탭(이 순서로 노출, 기본 선택 탭도 횡보·조정). `DiscoverTabs.tsx`는 탭 전환 껍데기, 탭별 내용은 `OpportunityTab.tsx` / `DailyReport.tsx` / `SimilaritySearch.tsx`로 분리(컴포넌트·API 경로 이름은 예전 그대로) |
| `positions/` | 내 매매장 — 가상 매수·매도 기록, 매일 수익률, 매도 신호와 "그때 팔았다면 몇 %" |
| `history/` | 스크리너 성적 — "따라갔으면 돈 벌었나"(기댓값 R)와 "어떤 상황에서 잘 맞나"(장세·시장·섹터별) |
| `api/daily-report` | 저점 매집 후보 API (Gold Standard 패턴 매칭, 구 "오늘의 추천") |
| `api/similar` | 패턴 유사도 검색 API |
| `api/stock-news` | 종목 뉴스 조회 |
| `api/revalidate` | 파이프라인이 갱신 후 캐시 무효화 호출 |
| `api/trades` | 가상 매수(POST)·매도(PATCH). **가격은 클라이언트에서 받지 않고 서버가 최신 종가를 직접 읽는다** — 브라우저 값을 믿으면 수익률 조작 가능. PIN(`TRADE_PIN`) 검증 |

## frontend/components/

`StockCard.tsx`(눌림목 카드) · `StockChart.tsx`(lightweight-charts, lazy load) ·
`WatchlistCard.tsx`(감시 카드) · `Scorecard.tsx`(성적 판정·구간별 막대)/`PerformanceTable.tsx`/`ExitSignalTable.tsx`
(스크리너 성적·포지션) · `LeadingSectors.tsx` · `MarketRegimeBadge.tsx` ·
`RealestateMediaSection.tsx`(부동산 홈 상단 뉴스·영상, 데이터 없으면 섹션째 숨김)

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
- **변동성 상한**: `screener.py`의 `MAX_VOLATILITY_RATIO`(0.10)는 `risk.ts`의
  `MAX_STOP_DISTANCE_PCT`(0.15)에서 역산한 값(`entry-1.5*ATR` 손절이 15% 넘게
  벌어지는 지점이 `ATR/entry=0.10`) — 둘 중 하나를 바꾸면 다른 쪽도 재계산해서 맞출 것
  (2026-09-02, 온투이노베이션 사례로 추가)
- **횡보·조정 채점**: `frontend/lib/opportunityScore.ts`(참조) ↔ `pipeline/src/watchlist.py` · `pipeline/src/opportunities.py`(실제 실행) — 상수 하나도 따로 안 놀아야 함
- **조정폭 밴드**: `MIN_DRAWDOWN`/`MAX_DRAWDOWN` 원본은 `watchlist.py`, 밴드 판정 함수(`in_band_tickers`)는 `opportunities.py`. `fundamentals.py`는 이 함수를 `main.py`를 통해 그대로 재사용하므로(독립 재정의 없음) 어긋날 일은 없음
- **하루 2회 실행 전제**: 파이프라인은 아침 전체(06:30 KST)와 저녁 KR 전용(16:30 KST)
  두 번 돈다(트리거는 `supabase/pg_cron_pipeline_trigger.sql`). 저녁 실행이 쓰는 KR
  `as_of`(당일 종가)와 **다음 날 아침** 실행이 쓰는 `as_of`가 같은 날짜라 매일 겹친다.
  그래서 날짜 단위로 쌓이는 테이블에 쓸 때는 upsert만 하면 안 되고, 그날 행을 지우고
  다시 넣어야 한다(`db.py`의 `_replace_day`) — 안 그러면 이번 실행에서 빠진 종목의
  지난 행이 유령처럼 남는다
- **아침 KR 재실행 스킵**: 위 항목의 "겹침" 때문에 아침 전체 실행의 KR 파트(스크리닝·
  기회 스냅샷·감시 종목 평가 전부)는 저녁 실행 결과와 완전히 같은 값을 다시 계산하는
  중복 작업이었다(2026-09-02 발견). `main.py`의 `_kr_pipeline_already_fresh()`가
  `market_regime`의 KR 최신 `date`를 확인해 `_KR_FRESH_WINDOW_DAYS`(3일, 주말 간격
  포함) 안이면 아침 KR 블록 전체를 건너뛴다. `--kr-only`(저녁) 실행은 이 체크를
  절대 타지 않는다 — 그게 최신 KR 데이터를 실제로 만드는 쪽이라 스킵하면 영영
  갱신이 안 된다. 저녁 실행이 실패해 오래 밀리면 창을 넘어가 아침이 안전망으로
  다시 돈다
- **하루 3번째 실행(US 재무건전성)**: 위 두 번(아침 06:30·저녁 16:30)과 별개로
  21:00 KST에 US 재무건전성만 도는 세 번째 실행이 있다(`us_financial_health_main.py`,
  `.github/workflows/us_financial_health.yml`). 본 파이프라인(`main.py`)과
  완전히 분리된 워크플로·pg_cron 트리거라 `main.py`의 스케줄 로직과는 무관하다
- **성적 집계의 판정 기간**: `scorecard.ts`의 `MAX_HOLD_BARS`(60거래일)를 지나면 강제 청산으로
  결론을 낸다. 이 값을 줄이면 아직 살아 있는 트레이드를 죽은 걸로 세고, 늘리면 판정 대기(pending)만
  쌓여 표본이 안 모인다. 손절은 1R로 가깝고 목표는 보통 2R 이상이라 손절이 훨씬 빨리 걸리므로,
  **"청산된 것만" 평균 내면 기댓값이 구조적으로 음수 쪽으로 치우친다** — pending을 집계에서 빼는
  이유가 이것이니 분모를 바꿀 때 주의
- **월봉 적립 누락**: `main.py`가 `refresh_monthly_ohlcv()` 뒤에 `accrue_long_monthly()`를
  반드시 함께 부른다. 이걸 빼면 일봉이 600일 밖으로 밀려날 때 그 구간 고점이 영영 사라져
  조정폭이 조용히 얕아진다(에러도 안 나고 몇 달 뒤에야 티가 난다)
- **시총 하한**: `pipeline.py`의 `KR_MIN_MARKET_CAP`(3,000억) / `US_MIN_MARKET_CAP`($20억)을
  눌림목 스크리너(`pipeline.py`)와 종목발굴 유니버스(`main.py`의 `kr_opp_mask`/`opp_mask`)가
  **같이** 쓴다 — 한쪽만 바꾸면 두 화면 기준이 갈라짐. 종목발굴은 일봉 수집 범위와
  스냅샷 계산 범위를 같은 티커 집합으로 묶어둬야 "일봉은 받았는데 화면엔 없는" 상태를 피함

- **부동산 지역코드**: 국토부 API는 `LAWD_CD`가 틀려도 **에러가 아니라 빈 결과**를 준다.
  그래서 `realestate.py`가 전 기간 0건인 지역을 따로 모아 로그에 남긴다 — 그 목록이
  `lawd_codes.py`를 고치는 근거다. 호출이 실패한 지역은 이 목록에서 빼야 한다(일시적
  장애를 코드 오류로 착각하지 않도록).
  **코드를 기억으로 찍어 맞히지 말 것** — 워크플로 `probe` 입력(예: `28,41`)으로
  해당 시도의 시군구 코드를 전부 두드려 보면 데이터가 나오는 코드가 확정된다.
  빈 결과를 주는 성질을 거꾸로 탐색에 쓰는 것이다.
  단 **백필과 같은 날 돌리지 말 것** — 개발계정 한도가 하루 1만 건인데 36개월
  백필이 5,544건을 쓴다. 한도가 닿으면 응답이 끊겨 프로브가 한 건도 못 받는다
  (실제로 4시간을 그렇게 버렸다). 지금은 연속 타임아웃 10건이면 중단하고 사유를
  알려준다
- **`lawd_codes.py`를 고치면 지도도 같이 볼 것**: `frontend/lib/data/capital-sigungu.json`은
  2018년 경계를 사전 계산해 저장해둔 정적 파일이라, `lawd_codes.py`에서 시군구 코드가
  분구·통합으로 바뀌어도 자동으로 안 따라간다 — 지도는 여전히 옛 코드 하나짜리 폴리곤인데
  실거래는 새 코드 여러 개로 들어와 화면이 회색(데이터 없음)으로 보인다(부천·화성 실사례,
  #71). 단순 분구(옛 코드 하나 → 새 코드 여러 개, 경계 자체는 안 바뀜)라면
  `realestateTrend.ts`의 `SPLIT_REGION_CHILDREN`에 매핑을 추가하면 된다(새 코드들을 건수
  가중 평균으로 합쳐 옛 폴리곤에 칠함). 인천 제물포·영종·서해·검단구처럼 경계 자체가
  갈라지는 경우(영종도가 중구에서 분리)는 이 방식으로 못 메운다 — 폴리곤 자체를
  다시 그려야 하므로 별도 작업으로 남겨둘 것.

## 알려진 이슈

- `MOLIT_API_KEY` 시크릿 미등록 — 워크플로가 시작 전에 키를 확인하고 **에러로 멈춘다**.
  (수집기 자체는 조용히 건너뛰지만, 그러면 40초 만에 초록불로 끝나 "다 됐다"로 보인다.)
  data.go.kr에서 "국토교통부_아파트 매매 실거래가 자료"와 "전월세 자료" 활용신청 후
  발급받은 서비스키를 Settings → Secrets and variables → Actions에 등록하면 된다.
  키는 Encoding/Decoding 어느 형태로 넣어도 된다(`normalize_service_key`가 처리).
  등록 후 첫 실행은 `workflow_dispatch`로 `months=36`을 줘서 과거를 채울 것
  (5,544건 호출이라 한 시간을 넘긴다 — 워크플로 `timeout-minutes`가 240인 이유)
- ~~`DART_API_KEY` 시크릿 미등록~~ — **2026-09-01 등록 완료**, KR 실적 수집 정상 동작 중
  (`dart_fundamentals.py`). 실행 로그에서 `KR 실적 수집 (N/N개 대상)... → M개 저장`으로 확인 가능
  (스킵되면 `KR 실적 수집 생략: DART_API_KEY 미설정` 한 줄만 남는다)
- `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET`, `YOUTUBE_API_KEY` 시크릿 미등록 (2026-09-03
  기능 추가 시점 기준) — `realestate_media.yml`이 둘 다 없으면 에러로 멈춘다(하나만
  없으면 그 소스만 건너뛰고 나머지는 정상 수집). **네이버 뉴스검색은 2026-09
  기준 구 개발자센터(developers.naver.com) 신규 발급이 막히고 NAVER API HUB로
  이관됐다** — 네이버클라우드플랫폼(ncloud.com) 콘솔에서 "NAVER API HUB" →
  "애플리케이션 등록" → "API 키 발급"으로 Client ID/Secret을 받는다(계정 전체의
  IAM Access Key/Secret Key `ncp_iam_...`와는 다른 값이니 혼동 주의 — 그건 이
  API 호출에 안 쓰인다). 엔드포인트는 `https://naverapihub.apigw.ntruss.com/search/v1/news`,
  인증은 `X-NCP-APIGW-API-KEY-ID`/`X-NCP-APIGW-API-KEY` 헤더(요청 파라미터·응답
  스키마는 구 API와 동일, 하루 25,000건 한도도 동일 — `realestate_media.py` 참고).
  YouTube Data API v3 키는 Google Cloud Console에서 발급(무료 할당량 있음,
  search.list 호출당 100 유닛 소모 — 일일 기본 할당량 10,000유닛 기준 하루 100회
  정도). 둘 다
  Settings → Secrets and variables → Actions에 등록하면 다음 실행부터 채워진다.
