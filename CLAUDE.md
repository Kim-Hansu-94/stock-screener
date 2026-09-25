# 보물지도 (stock-screener) — 구조 지도

작업 시작 전에 이 문서로 "어디에 뭐가 있는지"부터 찾을 것. 특히 `frontend/lib/queries/`는
화면별로 나뉜 5개 파일이니, 무작정 다 읽지 말고 아래 표로 필요한 파일·함수만 찾아서 Grep/Read.

**알고리즘(스크리닝 조건·채점 공식·상수) 작업이면 `docs/algorithms.md`부터, UI/디자인
작업이면 `docs/ui-guide.md`부터 볼 것** — 소스를 처음부터 다시 읽지 않아도 되게 상수·공식·
패턴을 미리 정리해 둔 문서다. 이 구조 지도(CLAUDE.md)는 "어디에 뭐가 있는지", 그 둘은
"그 안에 정확히 뭐가 들어있는지"를 담당한다. 백테스트 규칙은 `docs/backtest-guide.md`.

**저점 매집 후보 채점 작업은 2026-09-15에 일시정지 상태다** — 어디까지 했고 다음에 뭘 하면
되는지는 `docs/저점매집-작업노트.md`에 있다. 그 작업을 이어받는다면 거기부터 읽을 것.

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

## 외부 데이터가 필요하면 네이버부터 확인할 것

새로 외부 데이터를 가져와야 할 때는 **네이버에 있는지부터 본다**. 한국어 정보가 가장 촘촘하고,
이 저장소에서 실제로 가장 잘 버텨온 소스다 — 2026-09-09에 미국 ETF 제공사(iShares·Vanguard)·
stockanalysis·위키백과가 전부 막힌 상황에서 Russell 3000을 유일하게 채운 것도, 구글 뉴스로
새던 종목 뉴스를 살린 것도 네이버였다.

지금 쓰고 있는 네이버 경로:

| 용도 | 경로 | 키 |
|---|---|---|
| 뉴스 검색 (부동산·종목) | `naverapihub.apigw.ntruss.com/search/v1/news` | 필요 (NAVER API HUB) |
| 해외주식 시총순 목록 | `api.stock.naver.com/stock/exchange/{거래소}/marketValue` | 불필요 |
| 국장 일봉 | FinanceDataReader가 내부적으로 `fchart.stock.naver.com` 호출 | 불필요 |
| 코스피·코스닥 지수 일봉 | `api.finance.naver.com/siseJson.naver?symbol=KOSPI\|KOSDAQ` | 불필요 |

**다른 소스를 골랐다면 왜 네이버로는 안 되는지 한 줄 남길 것.** 단, 네이버가 만능은 아니다 —
국내 관점 데이터에 강하고 미국 현지 세부 데이터(업종 분류·재무제표 등)는 비어 있는 경우가 있다.
쓰기로 정하기 전에 프로브(`.github/workflows/universe_probe.yml` 방식)로 **실제로 값이 오는지
확인**할 것. 응답 키 이름이 예고 없이 바뀌는 내부 API가 많으므로, 키를 고정하지 말고 후보 중에서
찾고(`_rows_from_json` 참고) 실패 시 사유가 로그에 드러나게 짤 것.

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
| `market_indices.py` | 홈 상단 시황 위젯용 지수 스냅샷(코스피·코스닥·다우·나스닥·S&P500·**미국10년물**, 2026-09-15 추가) → `market_index_snapshot`. 미국10년물(`^TNX`)은 490590 매수체크(`frontend/lib/etfEntryCheck.ts`)의 금리 급등 신호에 쓴다 — **값이 퍼센트 그대로 온다**(4.96%가 4.961로 저장). CBOE 지수 원값은 수익률의 10배지만 yfinance가 이미 나눠서 주므로 **화면에서 또 10으로 나누면 안 된다** — 처음에 10배라고 단정하고 나눴다가 뉴스의 "10년물 5.02%"가 화면에 0.50%로 떴다(2026-09-15). 저장값은 `db_probe`의 `market_index_snapshot` 절이 그대로 찍는다(`미국10년물: close=4.960999965667725`) — **단위를 가정하지 말고 이걸로 확인할 것.** **미국 지수는 확정 종가일 수도, 장중 값일 수도 있다 (2026-09-15 변경)** — 원래 `_us_snapshot`이 `end`를 today로 줘서(배타적) 오늘 봉을 통째로 뺐고, 본 파이프라인도 06:30·16:30 KST **둘 다 미국장이 닫혀 있는 시각**에만 돌아서 화면 값이 늘 직전 거래일 종가였다(개장 22:30~05:00 KST). "뉴스는 5%인데 여기는 왜 4.96%냐"는 질문이 여기서 나왔다. 지금은 (1) `end`에 하루를 더해 **오늘 봉도 받고**, (2) `.github/workflows/market_indices.yml`(`python -m src.market_indices_main`)이 **4시간마다** 같은 수집만 따로 돌린다 — 그래서 미국장이 열려 있는 00:35·04:35 KST 실행은 **아직 안 끝난 봉**을 가져온다. **미국 국채는 주가지수와 장 시간이 다르다 (2026-09-15 실측)** — 21:39 KST(12:39 UTC, 미국 주식장 개장 전) 실행에서 다우·나스닥·S&P500은 9/14 종가인데 `미국10년물만 2026-09-15 종가 5.01`이 들어왔다. 국채는 런던·아시아 시간에도 거래되기 때문이다(같은 시각 국민일보 기사가 5.02%로 보도). 그래서 **10년물의 기준일은 주가지수보다 하루 앞설 수 있고**, 화면 문구를 "미국장은 밤 10시 30분에 열리므로"처럼 주식 기준으로 쓰면 안 된다. `usBarStatus`의 기준선(16:00 ET)은 정규장 마감이라 채권 마감(17:00 ET)과 한 시간 다르지만, **4시간 스케줄의 여섯 시각 중 16:00~17:00 ET에 걸리는 실행이 하나도 없어** 실제로는 문제되지 않는다(11:35/15:35/19:35/23:35/03:35/07:35 ET) — 스케줄을 바꾸면 이걸 다시 볼 것. **`market_index_snapshot`에는 그걸 구분하는 플래그가 없다** — 화면이 `frontend/lib/usMarketSession.ts`의 `usBarStatus(date, updated_at)`로 판정한다(저장 시각이 그 거래일 16:00 ET보다 이르면 장중). 컬럼을 늘리면 Supabase 마이그레이션을 손으로 돌려야 하고 안 돌리면 화면이 조용히 "마감 종가"라고 거짓말하므로, 파생할 수 있는 건 파생한다. `EtfWatchCard`·`MarketOverviewWidget` 둘 다 이 판정을 쓰므로 **한쪽 문구를 고치면 다른 쪽도 같이 볼 것**. `assessStopSignals`의 문구가 "어제→오늘"이 아니라 "직전→최근"인 것도 같은 이유다. **국내 지수를 `fdr.DataReader('KS11')`로 받으면 안 된다** — 개별 종목과 달리 이 경로는 거래소가 아니라 제3자의 GitHub CSV 캐시(FinanceData/fdr_krx_data_cache)를 읽어서 하루 이상 늦은 값을 **에러 없이 조용히** 준다(2026-09-09: 9/9 오후에도 마지막 행이 9/7이라 화면에 '국내 9/7 장마감 기준'이 떠 있었다). **yfinance(^KS11/^KQ11)도 못 믿는다**(2026-09-10): 야후는 KRX 일봉 확정이 늦어 아침 06:30 실행에서 에러 없이 9/8까지만 줬다(같은 실행에서 해외 지수는 9/9 정상 — 전날 저녁에 받은 9/9 값은 장중 실시간 행이었다). 그래서 지금은 **네이버 `siseJson`이 1순위**고(프로브로 9/10 아침에 9/9 종가 보유 확인), 순서는 네이버 → yfinance → fdr이다. 세 소스 모두 장중에 오늘 봉을 미완성으로 주므로 15:40 KST 이전 실행에서는 오늘 봉을 버린다(`drop_unfinished_kr_bar`). 소스가 살아 있는지는 `.github/workflows/kr_index_probe.yml`(`python -m src.kr_index_probe`)로 1분 만에 확인된다 |
| `market_indices_main.py` | 시황 지수 스냅샷 **전용** 엔트리포인트(`python -m src.market_indices_main`) — `.github/workflows/market_indices.yml`이 **4시간마다**(00:35/04:35/08:35/12:35/16:35/20:35 KST) 돌린다. 본 파이프라인도 매 실행 같은 수집을 하지만 하루 두 번뿐이고 둘 다 미국장이 닫혀 있는 시각이라, 미국 지수가 장중에 움직이는 걸 볼 수가 없었다(2026-09-15 사용자 요청). 지수 6개 수집은 수십 초라 따로 떼어낼 수 있다. 지수당 1행 upsert라 본 파이프라인과 동시에 돌아도 서로 덮어쓸 뿐이다. **하나도 못 받으면 exit 1** — 조용히 초록불로 끝나면 "4시간마다 갱신되고 있다"고 믿게 된다 |
| `sectors.py` | 주도 섹터 판정 |
| `market_regime.py` | 상승장/하락장 판정 |
| `opportunities.py` | 횡보·조정 후보 사전 계산 → `opportunity_snapshot` (프론트가 재계산 안 하도록). `in_band_tickers()`(조정폭 20~60% 판정)는 `fundamentals.py`도 대상 종목을 좁히는 데 재사용 |
| `watchlist.py` | 감시 종목(보유 종목) 평가 → `watchlist_status`. 감시 목록은 코드 상수(`WATCHLIST`, **2026-09-06부터 비어 있음** — 종목은 전부 사이트에서 관리한다) + 사이트에서 직접 추가한 `watchlist_tickers` 테이블(`/api/watchlist`)을 `get_combined_watchlist()`가 합친 것. 상수를 비운 뒤로는 목록이 통째로 빌 수 있는데, `get_watchlist_tickers()`가 조회 실패 시에도 빈 목록을 돌려주므로 "진짜 없음"과 구분이 안 된다 — 그래서 `run_watchlist`는 목록이 비면 정리(`prune_watchlist_status`)까지 건너뛴다(안 그러면 일시적 조회 실패 한 번에 `watchlist_status`가 통째로 지워진다). 감시 종목은 정규 스크리닝 유니버스 밖의 임의 종목일 수 있어, `run_watchlist`(정확히는 `_fetch_bars`)가 `stock_price_history`를 읽기만 할 뿐 직접 받아오지 않는다. `main.py`의 `_backfill_missing_watchlist_history()`가 이 종목들의 유일한 일봉 공급원이다 — 일봉 부족(`MIN_BARS` 미만) 종목은 3년 전체를 백필하고, 이미 충분한 종목도 최근 14일을 증분으로 계속 받는다(KR은 `_collect_kr_opportunity_rows`, US는 `prices_us.get_opportunity_histories`). 증분도 안 받으면 정규 유니버스처럼 다른 경로로 매일 갱신되는 게 아니라서 최초 백필 이후 차트·평가가 영구히 그 시점에 멈춘다(2026-09-05 발견·수정). **채점 로직은 `frontend/lib/opportunityScore.ts`의 포팅본 — 상수 바꿀 때 반드시 같이 수정** |
| `fundamentals.py` | 실적(매출·이익) 수집 → `stock_fundamentals`. `main.py`가 유니버스 전체가 아니라 `in_band_tickers()`로 좁힌 조정폭 밴드 종목만 넘김(밴드 밖은 화면에 안 뜨므로). 30일 주기 + 실행당 상한. KR은 `dart_fundamentals.py`, US는 yfinance로 분기 |
| `dart_fundamentals.py` | DART(전자공시) Open API로 국내 종목 실적 수집. `DART_API_KEY` 시크릿 필요 — 미설정이면 KR 실적 수집을 통째로 건너뜀(로그만 남기고 계속 진행). 우선주는 DART corpCode.xml에 자기 종목코드가 없어 이름에서 "우"/"N우B" 접미사를 떼어 보통주 corp_code로 대신 조회함(재무제표는 법인 단위라 회계적으로 문제없음) — 이름 매핑은 `main.py`가 KR 유니버스 전체에서 만들어 넘김. 손익 계정과 같은 API 응답(`fnlttSinglAcnt.json`)에 대차대조표 주요계정도 들어 있어, 재무건전성(유동자산·유동부채·부채총계·자본총계)도 추가 호출 없이 같이 뽑는다(2026-09-02) |
| `us_financial_health_main.py` | US 종목 재무건전성(대차대조표) 전용 수집 — 실적(`fundamentals.py`의 income_stmt)과 별도 낮은 빈도(21:00 KST, 같은 30일 주기)로 독립 실행. yfinance는 대차대조표가 손익계산서와 별도 호출이라 종목당 요청이 두 배가 되므로 매일 도는 본 파이프라인에 얹지 않음. 유니버스는 재수집하지 않고 그날 아침 본 파이프라인이 저장해 둔 `stock_universe`를 그대로 읽는다(`ScreenerDB.get_universe_tickers`). `stock_fundamentals.financial_health_updated_at`으로 실적용 `updated_at`과 신선도를 분리 추적 — 같은 컬럼을 쓰면 재무건전성만 갱신해도 "실적도 최근 갱신됐다"고 착각해 진짜 실적 갱신을 건너뛰게 된다. 별도 워크플로(`.github/workflows/us_financial_health.yml`) + 별도 pg_cron(`supabase/pg_cron_us_financial_health_trigger.sql`, 매일 21:00 KST) |
| `long_history.py` | 10년 월봉 수집 → `stock_long_monthly`. 과거 확정 구간이라 미시드 종목만 1회 |
| `split_guard.py` | 액면분할 등 소급 조정 감지 (증분 수집이 만드는 가짜 급락 방지) |
| `pattern_discovery.py` | Gold Standard 바닥 패턴 유사도 (저점 매집 후보 탭, 구 "오늘의 추천"). **거래량 트리거(`volume_triggered`, 화면의 ⚡ 배지)는 거래량만으로 판정하지 않는다** — 대량거래 + **양봉 또는 십자형**일 때만 참이다(『매매의 기술』: "거래량은 타이밍만 제공하고 방향은 봉의 모양이 결정한다"). 예전엔 거래량 2배만 봐서 투매(대량거래 장대음봉)에도 같은 배지가 붙어 정반대 신호가 구분되지 않았다(2026-09-14 수정). 시가가 없는 소스를 종가로 메우면 몸통이 0이라 **모든 대량거래일이 십자형으로 잡히므로**, 전 구간 시가=종가면 트리거를 끈다. 추천 결과에는 집계용 원본 수치(`drawdown_pct`·`days_since_low`·`vol_ratio`·`vcp`·`ma_align`·`higher_low`)도 함께 실어 `recommendation_history`에 남긴다
(`higher_low`는 점수에 안 들어가는 **관측 전용**이다 — 가산점으로 줬다가 성적이 나빠져
되돌렸고, 다른 방식으로 재시험할 근거로 기록만 남긴다). **채점 공식은 2026-09-14에 백테스트로 크게 고쳐졌다** — 거래량 점수가 성과와
**반대 방향**이었고(높을수록 만점인데 실제로는 높을수록 나빴다) 소진일수·거래량이 표본의
75~88%에게 만점을 줘 사실상 상수였다. 지금은 거래량이 **계단 하나**(1.5배 미만 전부 만점,
2.0배 이상 0점)이고 가중치가 하락률 0.5 / 거래량 0.3 / 소진일수 0.2다 — 거래량은
**줄 세우는 조건이 아니라 걸러내는 조건**이라는 것이 v8의 결론이다(1.5배 아래로는
성적에 뚜렷한 순서가 없다). 그 결과 "점수 상위가
오히려 나쁘다"가 해소됐다(70점 이상 중간값 −3.09% → 19.53%, 1~5위 0.00% → 11.59%).
**상수를 건드리기 전에 docstring v4~v8을 읽을 것** — 시험했다가 기각한 것(이평 정배열
제거·저점 높이기 보너스·만점 지점 당기기·소진일수 커트라인 30일)과 그 이유가 수치까지
남아 있다. 관통하는 교훈은 **조건 하나가 "좋은가"가 아니라 점수 공식이 성과와 같은
방향으로 가는가를 물으라**는 것이다. **하락률 곡선의 "골"은 고치지 않기로 했다 (2026-09-15)** —
5% 단위로 다시 재니 골 위치가 지평선마다 옮겨 다녀(60·120일 70~75%, 250일 65~70%) 구조가
아니라 잡음이었다. 대신 승률에서 깨끗한 게 나왔다: **60일은 깊을수록 떨어지고(64.1→60.3)
250일은 깊을수록 오른다(74.5→81.0).** 즉 **깊게 빠진 종목은 나쁜 게 아니라 느리다.**
점수는 보유 기간을 모르므로 어느 한쪽에 맞추면 다른 쪽 사용자에게 손해다 — 채점 대신
`DailyReport.tsx` 안내에 깊이별 승률 표를 넣어 해결했다. **`_score_candidate`는 일봉 배열만 받는 순수 함수라 과거 날짜로 되돌려 돌릴 수 있다** — 알고리즘 상수를 고칠 근거가 필요하면 실전 성적이 쌓이기를 기다리지 말고 `pipeline/research/backtest_pattern_features.py`로 3년치를 재생할 것 (`docs/backtest-guide.md` 맨 아래 절) |
| `db.py` | Supabase 클라이언트 래퍼 (`ScreenerDB`), 모든 `save_*`/`upsert` 메서드 |
| `naver_api.py` | 네이버 증권 내부 API 공통 헬퍼 — JSON이 아닌 응답(봇 차단 페이지는 200+HTML로 온다)을 사유가 드러나는 에러로 바꾸고, 감싸는 키 이름을 고정하지 않고 구조로 찾는다(`rows_from_json`/`find_first`). `universe_us.py`에 같은 함수가 있지만 그쪽은 손대지 않았다 — 유니버스 수집은 본 파이프라인 첫 단계라 리팩터링하다 깨지면 스크리닝 전체가 멈춘다 |
| `investor_flow.py` | **수급** — 국내 종목 일별 외국인·기관 순매매 → `investor_flow`. 소스는 네이버 금융 `item/frgn.naver` HTML 표(10년 넘게 같은 형태) 1순위, `m.stock.naver.com/api/stock/{code}/trend` 2순위. **네이버 금융은 아직 EUC-KR이라 인코딩을 지정 안 하면 컬럼명이 깨져 '외국인'을 못 찾고 조용히 빈 결과가 된다.** 원본 단위는 **수량(주)**이고 금액은 종가를 곱한 근사치다(장중 평균단가 아님) |
| `consensus.py` | **목표주가 컨센서스** — 증권사 평균 목표가 → `stock_consensus`. 네이버 3개 경로를 후보로 두고 앞에서부터 시도. **카드의 ATR 목표가와 합치지 않는다** — 전자는 애널리스트의 12개월 밸류에이션, 후자는 변동성 기반 단기 매매 목표라 평균 내면 둘 다 아닌 값이 된다 |
| `buyback.py` | **자사주 매입** — DART 공시 → `stock_buyback`. 네이버가 아니라 DART인 이유: 자기주식 취득은 공시 의무 사항이라 원본이 여기 있고, `DART_API_KEY`가 이미 등록돼 있다. **진행률이 두 개인 것이 의도적이다** — `amount_progress_pct`(취득 금액 기준, 진짜 진행률)와 `period_progress_pct`(기간 기준 근사치). 합치면 화면에서 어느 근거인지 알 수 없게 된다. 공시가 없으면 예외가 아니라 `None`을 돌려준다("자사주를 안 사는 회사"와 "못 받았다"를 구분) |
| `broker_flow.py` | **거래원**(증권사 창구별 매매) → `broker_trading`. 자사주 매입을 **진행 중에** 따라가기 위한 데이터다 — DART 결과보고서는 프로그램이 끝난 뒤에 나와서 진행 중 3~6개월간 아무것도 알 수 없기 때문. 자사주 취득 결정 공시에는 **위탁투자중개업자**(`cs_iv_bk`, SK하이닉스는 SK증권)가 적혀 있고, 거래소는 종목별 상위 매수·매도 창구를 매일 공개하므로 그 증권사의 순매수를 누적하면 매입량을 **추정**할 수 있다. **확정치가 아니다** — 그 창구 매수에 같은 증권사 일반 고객 주문이 섞이므로 화면에 반드시 '추정'으로 밝힌다. 네이버 표의 매수 수량 컬럼이 **'거개량'으로 오타**나 있어(2026-09-10 실측) 값은 컬럼 이름이 아니라 **열 위치**로 읽는다. 네이버가 그날 상위 5개만 주므로 **과거 소급이 안 되고**(표가 처음 도는 날부터 쌓임), 그날 6위 밖이면 빠져서 추정 진행률이 실제보다 낮게 나올 수 있다 |
| `trstk.py` | **자기주식 체결내역** — KRX KIND `/api/trstk/traded` → `buyback_trades`. 자사주 진행률의 **확정** 근거다. `buyback.py`의 DART 주요사항보고서가 "얼마를 사겠다"는 계획인 반면, 이건 거래소가 **매매일마다 공시하는 실제 체결수량**이라 진행 중에도 확정치를 쓸 수 있고 **소급도 된다**(그래서 수집이 며칠 끊겨도 다음 실행이 구멍을 메운다 — 거래원과 결정적으로 다른 점). 조건 이름은 화면 소스 그대로 `marketType`·`corpName`·`repIsuSrtCd`·`fromDate`·`toDate`·`pageNo`, 날짜는 **대시 없는 `YYYYMMDD`**(실측 확정). **전체 건수(`tot_cnt`)가 응답 본문이 아니라 각 행 안에** 들어 있어 그걸로 페이지를 멈춘다. `trstk_acqstdisp_tp_cd`는 1=취득·2=처분·0=신탁이라 **취득만 더해야** 진행률이 맞다. KIND는 403을 주는 소스라 세션(쿠키)·요청 간격·Referer 정합이 필수 |
| `buyback_probe.py` | 자사주 실제 매입량 소스 **탐색** 프로브(`.github/workflows/buyback_probe.yml`). 성패를 판정하지 않고 응답 구조만 찍는다 — 목적이 "살아 있나"가 아니라 "어떤 모양으로 오나"이기 때문. DART 공시서류원본파일(`document.xml`, 새 키 불필요)과 네이버 거래원을 같이 두드린다 |
| `kr_market_extras_main.py` | 위 3종 수집 오케스트레이션 — **본 파이프라인과 분리된 별도 워크플로**(`.github/workflows/kr_market_extras.yml`). **하루 두 번 돈다**: 1차 17:30 KST 전체 수집, 2차 18:40 KST `--trstk-only`(체결내역만). 당일 자기주식 체결수량이 **18시 이후**에 공시되므로 1차만으로는 확정 진행률이 영구히 하루씩 밀리고, 그렇다고 1차를 18시 뒤로 미루면 거래원이 깨진다(시간대를 타는 소스) — 한쪽을 맞추면 다른 쪽이 깨지는 구조라 나눠 돈다. 2차는 종목 선정·공시 조회를 다시 하지 않고 저장된 `stock_buyback`을 읽어 체결내역만 갱신한다. 셋 중 하나가 죽어도 나머지는 저장된다. 대상은 유니버스 전체가 아니라 **화면에 실제로 뜨는 국내 종목**(감시·보유 + 최근 스크리닝 + 횡보/조정 후보)이고 실행당 상한이 있다 |
| `kr_market_extras_probe.py` | 위 3종 소스가 살아 있는지 1분 만에 확인하는 진단(`.github/workflows/kr_market_extras_probe.yml`). 작업 컨테이너는 네이버·DART가 막혀 있어 거기서 확인이 안 된다 — universe_probe와 같은 이유·같은 방식. **응답 키 후보가 맞았는지는 이 출력으로만 알 수 있다**(값이 None이면 후보 목록에 실제 키를 추가해야 한다는 뜻) |
| `etf_holdings.py` / `etf_holdings_main.py` | **490590 구성종목·비중 수집** → `etf_holdings` (2026-09-25 추가, 별도 워크플로 `.github/workflows/etf_holdings.yml` 평일 09:10 KST). 예전엔 `etfEntryCheck.ts`에 종목·비중을 손으로 적어 뒀는데, 리밸런싱되면 아무도 모르고 화면이 **조용히 틀린 바구니로 신호등을 계산했다** — 실제로 2026-09-25 실측에서 10개 중 5개가 어긋나 있었다(인텔·오라클·버티브가 들어오고 마이크로소프트·메타가 빠졌는데 화면은 여전히 빠진 둘을 세고 있었다). 소스는 `m.stock.naver.com/api/stock/490590/etfAnalysis`의 `etfTop10MajorConstituentAssets`. **프로브로 실측한 제약 세 가지**: (1) **비중(`etfWeight`)을 안 준다** — 10개 전부 `"-"`다. 그래서 `주식 수 × 종가`로 낸다(추정이 아니라 비중의 정의 그대로). 단 **상위 10개만** 주므로 ETF 전체에서 몇 %인지는 알 수 없고 그 안에서의 **상대 비중**만 나온다 — 화면이 쓰는 것도 `cStageWeight / evaluatedWeight`라 충분하다. (2) **미국 종목은 `itemCode`가 빈 문자열**이라 이름으로 `stock_universe`와 이어야 한다. 네이버는 정식명(`"AMAZON.COM INC"`), DB는 통칭(`"Amazon"`)을 써서 접두사까지 본다. **후보가 둘 이상이면 잇지 않는다** — 틀린 비중이 조용히 들어가는 것보다 못 이었다고 드러내는 편이 낫다. 법인격 접미사는 **글자가 아니라 단어 단위로** 뗀다(글자로 자르면 `"ORACLE CORPORATION"`이 `"ORACLE ORATION"`이 된다 — 실제로 9개 중 4개를 이것 때문에 못 이었다). (3) **주가는 yfinance가 아니라 `stock_price_history`에서 읽는다** — 프로브에서 yfinance가 `OperationalError('database is locked')`로 ANET 하나를 흘려 비중이 통째로 틀어졌다. 못 이은 이름과 구성 변경은 `::warning::`으로 띄우고, 저장은 **통째로 갈아끼운다**(upsert만 하면 빠진 종목의 지난 행이 유령처럼 남아 계속 세게 된다). 소스가 살아 있는지는 `.github/workflows/etf_holdings_probe.yml`로 1분 만에 확인된다 |
| `realestate.py` / `realestate_main.py` / `lawd_codes.py` | 부동산 실거래 동향 (국토부 Open API). **주식 파이프라인과 분리된 별도 워크플로**(`.github/workflows/realestate.yml`, 주 1회) — 실거래는 신고 기한이 30일이라 매일 볼 이유가 없고, 여기가 실패했다고 주식 스크리닝이 죽으면 안 된다. `MOLIT_API_KEY` 필요 (미설정이면 조용히 건너뜀) |
| `realestate_media.py` / `realestate_media_main.py` | 부동산 관련 뉴스(네이버 뉴스검색 API)·유튜브(YouTube Data API) 링크 수집 — 홈 상단 노출용. **또 다른 별도 워크플로**(`.github/workflows/realestate_media.yml`, 4시간마다 하루 6회 — 2026-09-06 하루 1회에서 상향, 실행당 API 호출이 뉴스·유튜브 각 1회뿐이라 한도에 여유가 큼) — 실거래(주 1회)·주식 파이프라인과 모두 독립. 날짜별 이력을 안 쌓고 매 실행마다 테이블을 통째로 갈아끼우는 "오늘의 스냅샷"이다(어제 뉴스를 보여줄 이유가 없다). `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET`, `YOUTUBE_API_KEY` 필요 — 하나만 없으면 그 소스만 건너뛰고, 둘 다 없으면 실행 자체가 에러로 멈춘다(안 그러면 초록불로 끝나 "다 됐다"로 보임) |

## supabase/schema.sql — 테이블별 용도

| 테이블 | 쓰는 곳 | 읽는 곳 |
|---|---|---|
| `market_regime` | main.py | 눌림목 종목 탭 상승장/하락장 배지 |
| `market_index_snapshot` | market_indices.py (매 실행, 지수당 1행 upsert) | 홈 상단 시황 위젯 |
| `leading_sectors` | main.py | 눌림목 종목 탭 주도 섹터 |
| `screened_stocks` | main.py | 눌림목 종목 탭 카드 |
| `stock_price_history` | main.py (600일치, 매주 자동 정리) | 손익비 계산, 차트 |
| `stock_universe` | main.py | 종목명·섹터·시총 매핑 |
| `stock_long_monthly` | long_history.py (10년 시드) + `accrue_long_monthly()`(매 실행, 확정 월봉 적립) | 10년 고점, 장기 하락 경고, **3년 고점의 600일 이전 구간** |
| `opportunity_snapshot` | opportunities.py | 횡보·조정 탭 (사전 계산 결과) |
| `stock_fundamentals` | fundamentals.py(실적) + us_financial_health_main.py(US 재무건전성) | 실적 동반 하락 판정 + 재무건전성(유동비율·부채비율, KR·US) |
| `watchlist_status` | watchlist.py | 눌림목 종목 탭 감시 종목 카드 |
| `watchlist_tickers` | `/api/watchlist`(사이트 "관심 종목 추가"·"보유 종목 추가" 폼) | watchlist.py가 코드 상수와 합쳐 평가 대상으로 읽음. `category`로 매집 감시(accumulation, 기본값)와 포지션 관리(position)가 갈리고, 후자만 `avg_cost`(평단가)를 쓴다 (`supabase/watchlist_tickers.sql`로 생성) |
| `realestate_monthly` | realestate_main.py (주 1회) | 부동산 동향 탭 (`supabase/realestate.sql`로 생성). PK에 `area_band` 포함 — `ALL`(구 전체) + 면적 4구간 |
| `realestate_media` | realestate_media_main.py (4시간마다, 매 실행마다 전체 갈아끼움) | 부동산 동향 탭 홈 상단 뉴스·영상 (`supabase/realestate_media.sql`로 생성) |
| `investor_flow` | investor_flow.py (평일 17:30, 최근 60일 upsert) | 카드 펼침 시 수급 막대 (`supabase/kr_market_extras.sql`로 생성) |
| `stock_consensus` | consensus.py (종목당 최신 1행 스냅샷) | 카드 펼침 시 증권사 목표주가 |
| `stock_buyback` | buyback.py (종목당 최신 1행 스냅샷) | 카드 펼침 시 자사주 진행률 |
| `broker_trading` | broker_flow.py (자사주 프로그램 진행 중인 종목만, 매일) | 자사주 추정 진행률 계산 (`supabase/kr_market_extras.sql` 하단) |
| `buyback_trades` | trstk.py (취득 기간 시작일부터 매번 다시 받음 — 소급되는 소스라 구멍이 저절로 메워진다) | 자사주 **확정** 진행률 (`supabase/kr_market_extras.sql` 하단) |
| `etf_holdings` | etf_holdings_main.py (평일 09:10, 매 실행 전체 갈아끼움) | 490590 매수체크 화면의 구성종목·비중 (`supabase/etf_holdings.sql`로 생성). 티커를 못 이은 행도 ticker=null로 남긴다 — 조용히 사라지면 '구성에 없다'와 '이름을 못 이었다'가 구분되지 않는다 |
| `paper_trades` | 사이트의 매수/매도 버튼 | 보유 종목 점검 탭 (`supabase/paper_trades.sql`로 생성) |
| `recommendation_history` | main.py (저점 매집 후보 추천 기록 + 추천 시점 특성) | 스크리너 성적 탭의 **저점 매집 후보 성적** 섹션 (`getPatternRecommendations`). 특성 컬럼은 `supabase/recommendation_history_features.sql`로 추가 |

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
| `averageCost.ts` | 분할매수 평단 계산 — 차수별(단가·수량) 매수를 수량 가중 평균으로 합쳐 평단가·평가손익·본전 가격을 낸다. 매도 비용(KR 0.165% = 거래세·농특세 0.15% + 수수료, US 0.07%)을 평가손익에서 차감할 수 있고, 그래서 **본전 가격 ≠ 평단가**다(비용만큼 위). `simulateAddBuy()`는 물타기 시뮬레이션(지금 N주 더 사면 평단이 얼마). 순수 함수라 `averageCost.test.ts`로 검증. 라오니(raoni.xyz/calc)의 평단 손익계산기를 벤치마킹 |
| `investorFlow.ts` | 수급 요약(누적 순매매·연속 일수·매수일 수)과 금액 한국식 축약(`1.2조`/`3,400억`). **판정하지 않는다** — "외국인이 사니 좋다" 같은 결론은 내지 않고 값만 낸다(supportSignals.ts와 같은 원칙). `investorFlow.test.ts`로 검증. 입력 타입은 `FlowLike`(필요한 열만 있는 최소 형태)라 배지용 축소 조회도 같은 함수를 쓴다 — **연속 일수 규칙이 두 곳으로 갈라지면 배지와 상세가 다른 숫자를 말하게 된다** |
| `useLazyPriceHistory.ts` | 카드를 펼쳤을 때만 그 종목 일봉을 `/api/price-history`로 받아오는 훅. 한 번 받으면 다시 안 받고, 접으면 진행 중 요청을 취소한다 |
| `queries/krExtras.ts` | 수급·컨센서스·자사주 조회. `getKrExtrasSummaries()`는 **접힌 카드 배지용 요약**(종목당 숫자 서너 개)을 서버에서 미리 낸다 — 상세는 펼쳤을 때 `/api/kr-extras`가 맡는다. 자사주 진행률의 근거 우선순위(확정→추정→기간)를 `MarketExtrasPanel`과 **똑같이** 골라야 배지와 상세가 같은 숫자를 말한다. **조회 실패·표 없음이 정상 상태**다(별도 워크플로가 처음 돌기 전까지) — 예외를 던지지 않고 빈 값을 돌려주며, 화면은 그 섹션만 숨긴다 |
| `risk.ts` | 손절/목표가/손익비 계산 (`computeStopTarget`). 추세 종목(`trendFrame`) vs 횡보 종목(`rangeFrame`) 틀 분리 |
| `riskGrade.ts` | 손익비 색상 등급 기준 (틀별로 다름) |
| `scorecard.ts` | 스크리너 성적 집계 — 추천을 앞으로 걸어 목표/손절/기간만료로 판정하고 기댓값(R)·본전선·구간별 성과를 낸다. 순수 함수라 `scorecard.test.ts`로 검증 |
| `opportunityScore.ts` | 횡보·조정 매력도 점수 **참조 구현** — 실제 채점은 `pipeline/src/watchlist.py`가 포팅해서 수행. 상수 바꿀 때 항상 같이 수정 |
| `exitSignal.ts` | "이제 팔 때" 판정 — 진입일부터 하루씩 걸어 처음 걸린 날을 찾는다. **컨셉(`paper_trades.source`)에 따라 규칙이 갈린다**: 눌림목은 손절/목표 + 대량거래음봉·하락장·주도섹터이탈·60일선하회, 횡보·조정은 **가격만**(손절/목표 + 진입 시점 바닥 이탈). 횡보·조정 종목은 구조상 60일선 아래라 눌림목 규칙을 걸면 진입 다음 날 바로 신호가 뜬다. **신호 시점 가격을 저장하지 않고 매번 재현한다**(사이트에 안 들어온 날의 신호를 놓치지 않고, 기존 보유분에도 소급 적용) |
| `buySignal.ts` | 매력도 점수 → 매수 등급(적극검토/매수검토/관망) 변환 |
| `supportSignals.ts` | **포지션 관리** 카드의 지지 신호 점검 — 이미 보유 중인 종목의 추가 매수(물타기) 타이밍 참고용으로 5개 조건(120일선 근접 ±5% · 일목구름 지지 · RSI 과매도(35 이하) 후 반등 · 저점 높이기(20일) · 거래량 실린 상승)을 각각 판정한다. 매집 감시(`watchlist.py`)와 목적이 정반대라 **박스 수축을 요구하지 않는다** — SK하이닉스처럼 변동성 큰 대형주는 60일 박스폭 조건에 구조적으로 영원히 걸려서, 안 맞는 잣대를 들이대는 꼴이 되기 때문(2026-09-06). 일목구름은 선행스팬이 26봉 앞으로 그려지므로 **오늘 가격과 비교할 구름은 26봉 전 값**이다(`ICHIMOKU_SHIFT`) — 이 보정을 빼면 아직 오지 않은 미래 구름과 비교하게 된다. 충족 개수를 단일 "매수 등급"으로 합치지 않는 것도 의도적이다(지지선은 뚫리기도 하므로 근거를 감춘 초록불 대신 조건별 숫자를 그대로 노출). `summarizeSupportSignals()`는 그 5개 판정을 한 문단 코멘트로 합친다 — 지지 계열(120일선·구름·저점)과 수요 계열(RSI·거래량)로 나눠 2×2 결론을 고르는 **규칙**이지 AI가 매일 새로 판단하는 게 아니다(사이트는 값만 읽어 그리는 정적 앱이라 판단 주체가 없다). 판정 불가(`met: null`) 조건은 미충족으로 세지 않는다 — 그러면 실제보다 비관적으로 나온다. **'거래량 실린 상승'이 계속 0.9배로 나오는 건 버그가 아니다 (2026-09-23 확인)** — `.github/workflows/volume_probe.yml`(`python -m src.volume_probe 000660 KR`)로 DB 저장값과 거래소 원본을 맞대어 보니 30일 내내 한 주 단위까지 같았고(오늘 봉만 시간외 거래분 차이), 계산도 맞았다. SK하이닉스 거래량이 8월 대비 실제로 3분의 1가량 줄었을 뿐이다(8/12~8/21 일평균 469만 → 9/17~9/23 329만). 8월 중순이 유난히 많았던 건 8/20 자사주 취득 시작 무렵이라 그렇고, 그 터진 날들이 아직 '직전 20일 평균'에 남아 있다. **다만 이 비율은 1을 넘기가 원래 어렵다** — 156일을 재니 중간값 0.93, 61%가 1 이하였다(편향이 없다면 중간값이 1.00이어야 한다). 거래량은 가끔 확 터지는 분포라 짧은 평균(5일)을 긴 평균(20일)으로 나누면 터진 날 하나를 분모가 오래 물고 있어 대체로 1보다 작게 나온다. 판정 기준(>1)은 지금까지의 일관성을 위해 그대로 두기로 했고(사용자 결정), 대신 **문구에서 단정을 뺐다** — 원래 '매수세 유입 흔적 없음'이라고 적어서, 주가 +5.9%에 자사주를 매일 사들이는 중에도 '사는 사람이 없다'로 읽혔다(자사주 매입처럼 꾸준히 조금씩 사는 수요는 거래량을 터뜨리지 않는다). 이 지표가 아는 건 '거래량이 직전 20일보다 늘었는가' 하나뿐이니 그것만 말한다 — `supportSignals.test.ts`가 문구를 고정해 둔다 |
| `etfEntryCheck.ts` | **490590(RISE 미국AI밸류체인데일리고정커버드콜) 매수체크**(`/`, 사이트 첫 화면, 2026-09-15 추가) — 사용자가 직접 정한 개인 매매 체크리스트를 그대로 옮긴 전용 계산이다(일반 스크리닝 알고리즘 아님). 490590이 **실제로 담고 있는 미국 개별주**(`PROXY_HOLDINGS`에 티커+비중으로 하드코딩)의 일봉으로 A(하락 중)/B(하락 멈춤)/C(상승 전환) 3단계를 판정하고, C단계 **비중**으로 신호등(🔴~🟢🟢)을 매긴다. **처음엔 오라클·알파벳·엔비디아·AMD·마벨 5개를 동등하게 세고 있었는데 실제 구성과 달랐다 (2026-09-16 수정)** — 사용자가 증권사 앱에서 확인한 상위 10개에 **오라클과 AMD는 아예 없었고**(사용자 지시로 제외), 14.67%짜리 엔비디아와 5.01%짜리 아리스타가 똑같이 1표씩이었다. 지금은 NVDA 14.67 · GOOGL 13.97 · MRVL 10.46 · PLTR 5.80 · MSFT 5.70 · META 5.06 · ANET 5.01 · AMZN 4.65 **8종목(합 65.32%)**이고, 신호등 경계는 개수 기준 1/5·2/5·3/5·4/5와 같은 자리에 오도록 비중 30·50·70·90%로 옮겼다(`TRAFFIC_THRESHOLDS`) — 새로 고른 값이 아니다. **분모는 ETF 전체 비중이 아니라 '판정 가능한 비중'이다** — 일봉이 없는 종목이 점수를 조용히 끌어내리면 "데이터가 없다"와 "안 올랐다"가 구분되지 않는다(`supportSignals.ts`의 '판정 불가는 미충족으로 세지 않는다'와 같은 원칙). **상위 10개 중 둘은 못 넣는다**: TSM(4.3%)은 ADR이라 정규 유니버스 밖이고 `stock_price_history`에 **0봉**이다(db_probe 실측), RISE 미국AI밸류체인TOP3Plus(4.6%)는 국내 상장 ETF라 `market='KR'`로 조회해야 하고 무엇보다 **이름 그대로 AI 상위 3개를 담아** NVDA·GOOGL·MRVL을 두 번 세게 된다. 화면이 이 둘을 이름까지 밝혀 적는다("나머지는 옵션·현금"이라고 뭉뚱그리면 거짓말이 된다). ~~비중은 손으로 적어 둔 스냅샷~~ → **2026-09-25부터 `etf_holdings` 테이블에서 온다**(`pipeline/src/etf_holdings.py`). 코드의 `FALLBACK_PROXY_HOLDINGS`는 **수집 전·실패 시의 폴백**일 뿐이고 이미 낡았다 — 화면이 `fromDb`로 폴백을 쓰고 있는지 밝힌다. `assessProxyBasket`·`assessStopSignals`가 구성종목을 **인자로 받으므로**, 코드 상수를 고쳐도 화면은 DB를 따른다. `ProxyTicker`가 리터럴 유니언이 아니라 `string`인 것도 이 때문이다(종목이 런타임에 바뀐다). **매수 중단 신호의 '한꺼번에 무너짐'은 비중 40% 이상 **또는** 3종목 이상(OR)이다** — 원래 규칙 "NVIDIA·AMD·Marvell 동시 저점 이탈"을 종목이 8개로 늘어난 뒤에도 같은 뜻으로 옮긴 것이고, 매수를 멈추라는 신호라 늦게 울리는 것보다 일찍 울리는 쪽(OR)을 택했다. 40%는 백테스트로 검증한 값이 아니다. 반면 'AI 구성종목 전체 분위기'는 **개수**로 본다(판정된 것 중 하나만 빼고 전부 A) — 비중으로 재면 큰 종목 둘만 버텨도 "동반 하락이 아니다"가 돼서 정작 '전체 분위기'라는 질문에 답하지 못한다. 1~4차 분할매수(500→1,000→1,500→2,000만원, **2026-09-17 조정**. 원래 500→1,500→1,500→1,500이었는데 1→2차 사이 금액이 3배로 뛰는데 그 사이 확신이 3배로 세진다는 근거가 없어서(1차 비중 30%→2차 50%, 딱 그만큼만 세짐) 계단을 완만하게 폈다. 4차가 제일 크지만 여전히 선택사항이다) 조건과 매수 중단 신호를 계산한다. **490590 자체는 이제 어떤 기준으로도 판정하지 않는다 — `classifyStage`는 구성종목 전용이다 (2026-09-17, 2단계 결정).** 1단계: 사용자 질문("타이밍이 490590 자체 차트 기준인데, 보유종목 차트 동향 기준으로 잡는 건 어떨까")을 `research/checkTrancheGates.ts`(이미 삭제됨, 아래 참고)로 490590 실제 477봉(2024-10-02~2026-09-16, 판정 가능 341일)에 대고 재보니, **구성종목이 이미 신호를 준 날의 절반(2차 48%, 3차 50%)을 490590 자체 조건(20일선 회복·직전 고점 돌파·신고가)이 막고 있었다**(1차의 '저점 방어'는 94.7%로 거의 항상 열려 있어 병목이 아니었다). 490590은 커버드콜(콜옵션 매도) 상품이라 상승분 일부를 넘겨주므로, 구성종목이 신고가를 계속 갱신해도 490590 자체는 좀처럼 신고가를 못 만드는 구조적 이유가 있어 보인다는 게 이 실측의 해석이다 — 옵션 이론상 일반론이 아니라 490590 실측으로 확인됐다. 그래서 2~4차의 490590 자체 조건을 먼저 뺐다(1차의 '저점 방어'는 병목이 아니었고 구성종목으로 대신할 수 없는 별개의 안전장치라 남겨뒀다). **2단계**: 그 뒤 사용자가 원칙 자체를 문제 삼았다 — "이 ETF(커버드콜 파생 상품) 자체를 20일 이동평균·구조적 추세 같은 주식 기술적 기준으로 판단하는 것 자체가 의미 없다"는 것. 병목 빈도와 무관하게 490590 자체에는 이런 기준을 아예 적용하지 않기로 하면서 1차의 '저점 방어'도 마저 뺐고, 화면의 "490590 자체 판정" 섹션(A/B/C 배지·상승 전환 조건 목록)도 통째로 지우고 현재가·차트만 보여주는 절로 바꿨다(`EtfWatchCard.tsx`). 결과적으로 `buildTrancheGuide`는 이제 `proxy` 하나만 받고, 4개 차수 전부가 구성종목 비중 조건 하나만 본다 — 신호등과 완전히 같은 근거라 "🟡면 2차, 🟢면 3~4차"로 그대로 읽어도 된다. 진단에 썼던 `research/checkTrancheGates.ts`는 목적을 다하고 삭제했다(2단계 이후엔 비교할 490590 자체 조건이 아예 없어져 스크립트가 성립하지 않는다) — 근거 수치는 이 문단과 git 이력에 남아 있다. **뉴스를 읽고 판단해야 하는 항목(FOMC 발언 성격, AI주 동반 하락, 나스닥 급등 후 반납)은 계산하지 않는다** — `automatic: false`/`triggered: null`로 남기고 화면이 `StockNewsFeed`로 네이버 뉴스를 띄워 직접 읽게 한다. 이 A/B/C 판정은 검증된 백테스트 전략이 아니라 사용자가 정한 경험적 기준이므로, 상수(구간 길이·임계값)를 바꾸기 전에 `etfEntryCheck.test.ts`부터 볼 것. **매수 중단 신호는 "나쁜 일의 이름 + ✓/🚨"로 쓰면 안 된다 (2026-09-15)** — 처음엔 "490590이 최근 저점을 재차 이탈"을 제목으로 놓고 ✓를 붙였는데, ✓가 "그 나쁜 일이 실제로 일어났다"로 **정반대로** 읽혔다(사용자 지적: "뭔 소린지 모르겠다"). 지금은 `StopSignal.headline`이 현재 상태를 그대로 서술해(지키고 있습니다 / 깨고 내려갔습니다) 문장만 읽어도 뜻이 통하고, 배지는 색이 아니라 **글자**('이상 없음'/'경고'/'확인 불가')로 거든다 — `--accent`(연한 파랑)와 `--down`(파랑)이 서로 비슷해 배경색만으로는 정상/경고가 안 갈리기 때문에 경고에는 왼쪽 굵은 띠를 함께 준다. 뉴스로 판단할 항목은 `MANUAL_STOP_CHECKS` 상수로 **자동 판정 목록에서 빼서** 따로 보여준다(섞으면 뭘 내가 해야 하는지 흐려진다). 결론 한 줄은 `summarizeStopSignals()`가 맡는다 — 항목을 다 읽고 머릿속에서 합치게 두지 않으려는 것. **개수만 말하고 조건 이름을 감추지 말 것 (2026-09-15)** — 화면이 "상승 전환 조건은 5개 중 1개만 충족"이라고만 적어서 정작 그 5개가 뭔지 어디에도 없었다. 지금은 `classifyStage`가 `upturnConditions`(이름 + `why` 한 줄 설명 + 판정에 쓴 실제 숫자)를 **단계와 무관하게 항상** 채워 돌려주고, 화면이 그대로 편다. **`describeTenYearYield()`도 같은 원칙이다** — 10년물 금리 숫자만 던지면 높은지 낮은지를 알 수 없어 수준·의미를 함께 준다. **거래량 조건은 방향까지 본다 (2026-09-16)** — 처음엔 "최근 5일 평균 > 그 이전 20일 평균"만 봐서 **던지느라 터진 거래량도 매수세로 셌다**. `pattern_discovery.py`가 2026-09-14에 고친 것과 **똑같은 실수**다(『매매의 기술』: "거래량은 타이밍만 제공하고 방향은 봉의 모양이 결정한다"). 하루가 아니라 구간을 보므로 봉 하나의 모양 대신 `buyingVolumeShare()`(양봉·십자형 날 거래량 비중)로 재고, 거래량이 늘었고 **그 비중이 0.5 이상**일 때만 충족이다 — 0.5는 "오른 날과 내린 날에 똑같이 실렸다"는 중립선이지 조정한 임계값이 아니다. 전 구간 시가=종가인 소스는 모든 봉이 십자형이 돼 비중이 항상 1이 되므로 `null`(판정 불가)로 돌린다(pattern_discovery가 트리거를 끄는 것과 같은 이유). **`etfEntryCheck.test.ts`의 `bars()` 헬퍼가 시가를 전날 대비 0.5 옮기는 것도 이 때문이다** — 시가=종가로 두면 이 경로를 한 줄도 안 지나간다 |
| `longTermContext.ts` | 3년 월봉 + 10년 월봉 병합, 장기 고점/하락 판정 |
| `fundamentals.ts` | 실적 데이터 → 가치함정/밸류에이션조정 판정 |
| `similarity.ts` | 패턴 유사도 검색 (SimilaritySearch 탭용) |
| `sectorMap.ts` | 섹터명 한글 번역 |
| `calculations.ts` | 등락률·SMA·볼린저밴드 등 차트용 순수 계산 |
| `research/backtestEtfStage.ts` | **490590 A/B/C 판정을 과거로 되돌려 재는 리서치 스크립트** (2026-09-16). 490590은 눌림목·저점 매집 후보와 달리 **성적 집계가 없어서**, 조건을 "정밀하게" 고쳐도 좋아졌는지 알 방법이 없다 — 그래서 조건을 손대기 전에 이걸로 잰다(저점 매집 후보에서 거래량 점수가 성과와 **정반대 방향**이었던 전례가 있다). **파이썬으로 포팅하지 않는다** — Node 22가 타입만 벗겨 `.ts`를 그대로 실행하므로 화면이 쓰는 `classifyStage`를 **그대로 import**한다(포팅본을 만들면 `opportunityScore.ts` ↔ `watchlist.py`처럼 갈라질 동기화 지점이 하나 더 생긴다). 그래서 `tsconfig.json`에 `allowImportingTsExtensions`가 켜져 있다(noEmit이라 빌드엔 영향 없음). 490590 하나로는 표본이 턱없이 모자라(476봉 ≈ 2년) **같은 판정 함수를 US 유니버스에 돌린다** — 어차피 대장주 5개를 판정하는 그 함수다. 자격증명이 필요해 작업 컨테이너에서는 못 돌리고 `.github/workflows/etf_stage_backtest.yml`(수동 실행)로 돌린다. 출력은 ① 단계별 ②-초과 **시장 효과를 뺀** 단계별 ② **조건별 충족/미달 성과 차이**(원수익 + 시장 효과 뺀 값) ③ 충족 개수별 단조성 ④ 20일선 회복 필수화 효과 ⑤ 옛 기준 vs 새 기준. **2026-09-16에 이걸로 조건 2개를 뺄 뻔했다가 되돌렸다 — 그 과정이 이 스크립트의 사용법 그 자체다.** 세 번 돌렸고 세 번 다 결론이 달랐다: (1) 103종목 → "고점 돌파·거래량이 거꾸로다", (2) 3,679종목 → "**조건 5개가 전부** 거꾸로고 A단계(하락 중)가 제일 좋다", (3) 3,679종목 + 시장 효과 제거 → "**우위가 있는 조건이 하나도 없다**"(전부 ±0.6% 안, 부호가 지평선마다 바뀜). 교훈 셋. **첫째, 대상을 시총 순으로 고르면 안 된다** — `stock_price_history`에는 S&P500+NASDAQ100만 있어서(`main.py`의 `US_OPP_INDEXES`, Russell 3000은 받아와도 용량 때문에 저장 안 함) 시총 순으로 뽑으면 그 집합과 어긋난 순서로 뽑게 된다. 400개 훑어 53종목, 2,500개 훑어 103종목이었고 **상한을 올려도 안 늘었다**. 지금은 `pipeline/src/backtest_bars_dump.py`가 유니버스 전체 일봉을 yfinance로 받아 NDJSON으로 떨어뜨리고 (`BARS_FILE`), DB에 안 쓰므로 용량 영향이 0이다. **둘째, 시장이 오른 효과를 빼지 않으면 조건이 아니라 장세를 재게 된다** — 표본 기간이 강세장이라 많이 빠진 종목일수록 크게 되튀었고, 그게 "하락 중일 때 사면 좋다"로 찍혔다. 날짜별로 그날 표본 전체의 중앙값을 빼면 그 우위가 통째로 사라진다(A/B/C 승률이 전부 50%). **셋째, 생존 편향은 못 뺀다** — 유니버스가 *오늘* 기준 시총 상위라, 2년 전 폭락 종목이 목록에 있다는 건 그 사이 회복했다는 뜻이다. 과거 시점 유니버스를 쌓기 시작해도 2년 뒤에나 쓸 수 있다. **그리고 표본 건수에 속지 말 것**: 71,597건은 3,679종목 × 20거래일마다 한 번(종목당 약 19.5회)이고, 60일 성과를 20일 간격으로 보므로 **연속한 세 표본이 서로 겹친다**. 믿을 숫자는 건수가 아니라 종목 수다 |
| `research/checkTrancheGates.ts` | **1~4차 분할매수 게이트에서 구성종목 조건과 490590 자체 조건 중 무엇이 매수를 막는지 재는 진단** (2026-09-17). `backtestEtfStage.ts`와 같은 원칙으로 화면이 쓰는 `assessProxyBasket`→`classifyStage`→`buildTrancheGuide`를 그대로 import해서, 490590의 과거 각 거래일을 하루씩 걸으며 그 시점까지의 데이터만으로 재현한다. 이 스크립트의 실행 결과(2~4차에서 절반이 막힘)가 `etfEntryCheck.ts`의 2~4차에서 490590 자체 조건을 뺀 근거다 — **조건을 바꾼 뒤에는 이 스크립트를 다시 돌려도 의미가 없다**(2~4차 autoConditions가 이제 구성종목 조건 하나뿐이라 '490590 자체 조건'을 분리해서 잴 것이 없어졌다). `.github/workflows/check_tranche_gates.yml`(수동 실행)로 돌린다.
| `usMarketSession.ts` | 미국 지수 스냅샷이 **확정 종가인지 장중 값인지** 가리는 순수 계산(`usBarStatus`). DB에 플래그가 없어 `date`(미국 거래일)와 `updated_at`(저장 시각)에서 파생한다 — 저장 시각이 그 거래일 16:00 ET보다 이르면 장중이다. 서머타임은 `Intl`의 `America/New_York`에 맡긴다(직접 계산하면 EST 구간에서 한 시간 틀린다 — `usMarketSession.test.ts`가 두 구간을 다 고정해 둔다). 판정 불가는 `'final'`로 밀지 않고 `'unknown'`으로 남긴다: 모르는 것을 "마감 종가"라고 단정하면 화면이 틀린 말을 하게 된다 |
| `volumeProfile.ts` / `volumeProfilePrimitive.ts` | **매물대**(가격대별 거래량) — 앞쪽이 순수 계산(`computeVolumeProfile`, `volumeProfile.test.ts`), 뒤쪽이 lightweight-charts 프리미티브다. `StockChart`의 `volumeProfile` 옵션으로 켠다. 일봉엔 틱이 없어 하루 거래량을 그 봉의 **저가~고가에 고르게 흩뿌려** 근사한다 — 종가 한 점에 몰아주는 것보다 실제 분포에 가깝지만 **체결가별 정확한 거래량은 아니다**. 커스텀 시리즈(`ichimokuCloudSeries.ts`)가 아니라 프리미티브인 이유: 매물대는 시간축을 따라 흐르는 값이 아니라 가격축에 붙은 가로 막대라 시점별 데이터 배열로 표현할 수 없다. 색은 등락색(빨강·파랑)을 피해 중립 슬레이트를 쓴다 — 빨강/파랑을 쓰면 "오른 매물대/내린 매물대"로 오해된다 |
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
| `page.tsx` | **홈(`/`)** — **490590 매수체크**(2026-09-15부터, 이전엔 부동산이었음). 사용자의 개인 매매 체크리스트를 그대로 옮긴 전용 화면 — 사이트를 열면 바로 보이도록 최상단 겸 루트로 배치했다. 계산은 `lib/etfEntryCheck.ts`, 렌더는 `components/EtfWatchCard.tsx`. 감시 종목 기능처럼 임의 종목을 추가하는 화면이 아니라 490590 하나만을 위한 고정 화면이다. 490590 일봉은 `종목발굴 → 감시 종목`에서 관심 종목으로 추가해야 쌓인다(정규 스크리닝 유니버스 밖이라 이 화면이 직접 받아오지 않음, `watchlist.py` 항목 참고) |
| `realestate/` | 부동산 동향(구 홈, 2026-09-15에 루트에서 이동). 수도권 시군구별 아파트 매매·전월세 월간 집계. `?region=코드`로 지역 목록 ↔ 지역 상세(구간별 펼치기) 전환. 목록은 매매 평균가 내림차순 + 지도(`components/RealestateMap.tsx`, 매매가 색상 choropleth), 표시는 `components/RealestateTables.tsx`. 지역 목록(개요) 화면 최상단에는 `RealestateMediaSection.tsx`(관련 뉴스·유튜브, 지역과 무관한 전국 단위라 지역 상세 화면엔 없음). **탭 순서가 두 번 개편됐다**: 2026-08엔 구 `realestate/`가 루트로 오면서 구 홈이 `pullback/`로 이동했고, 2026-09-15엔 490590 매수체크가 루트를 차지하면서 부동산이 다시 `realestate/`로 밀려났다 |
| `pullback/` | 눌림목 종목 — **포지션 관리 카드**(상단) + 한국/미국 눌림목 스크리닝 (구 홈, 경로 `/pullback`). 포지션 관리는 이미 보유 중인 종목(`watchlist_tickers.category='position'`)의 추가 매수 타이밍을 보는 카드로, 매일 확인하는 성격이라 여기 상단에 둔다 |
| `discover/` | 종목발굴 — 횡보·조정(사전계산) / **감시 종목**(매집 감시) / 저점 매집 후보(패턴유사도, 구 "오늘의 추천") / 패턴검색 4탭(이 순서로 노출, 기본 선택 탭은 횡보·조정). `DiscoverTabs.tsx`는 탭 전환 껍데기, 탭별 내용은 `OpportunityTab.tsx` / `WatchlistCard.tsx` / `DailyReport.tsx` / `SimilaritySearch.tsx`로 분리(컴포넌트·API 경로 이름은 예전 그대로). 매집 감시는 2026-09-06에 눌림목 탭에서 옮겨왔다 — 눌림목은 단기매매, 매집 감시는 "아직 안 산 종목이 매집 구간에 들어왔는가"를 기다리는 장기 관점이라 컨셉이 갈린다 |
| `positions/` | 내 매매장 — 가상 매수·매도 기록, 매일 수익률, 매도 신호와 "그때 팔았다면 몇 %" |
| `history/` | 스크리너 성적 — "따라갔으면 돈 벌었나"(기댓값 R)와 "어떤 상황에서 잘 맞나"(장세·시장·섹터별) |
| `api/daily-report` | 저점 매집 후보 API (Gold Standard 패턴 매칭, 구 "오늘의 추천") |
| `api/similar` | 패턴 유사도 검색 API |
| `api/stock-news` | 종목 뉴스 조회 — **네이버 뉴스검색만 쓴다**(2026-09-09, 구글 뉴스 제거). 엔드포인트·인증 헤더는 `realestate_media.py`와 동일한 NAVER API HUB다 — 이 라우트만 구 주소(`openapi.naver.com` + `X-Naver-Client-Id`)에 남아 있어서 HUB 키로는 인증이 깨졌고, 조용히 구글로 내려가 종목과 무관한 기사가 뜨고 있었다. 검색어에는 항상 "주가"를 붙이고, 미장 종목도 한글명(`name_kr`, KIS 마스터에서 옴)이 있으면 티커 대신 그걸로 검색한다 — 네이버는 한글 기사라 '엔비디아'가 'NVDA'보다 훨씬 잘 걸린다. **`NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET`는 GitHub Actions 시크릿과 별개로 Vercel 환경변수에도 있어야 한다** — 없으면 기사가 0건이 아니라 `error: 'NAVER_CLIENT_ID/SECRET 미설정'`으로 응답한다(조용히 비면 '뉴스 없는 종목'으로 오해하므로) |
| `api/revalidate` | 파이프라인이 갱신 후 캐시 무효화 호출 |
| `api/trades` | 가상 매수(POST)·매도(PATCH). **가격은 클라이언트에서 받지 않고 서버가 최신 종가를 직접 읽는다** — 브라우저 값을 믿으면 수익률 조작 가능. PIN(`TRADE_PIN`) 검증 |

## frontend/components/

`KrExtrasBadges.tsx`(접힌 카드의 요약 배지 — 외국인 수급·목표가·자사주를 한 줄로. 새 정보가 전부 '펼쳐야 보이는' 곳에 있으면 매일 보는 화면에서 없는 기능이나 마찬가지라 만들었다. 상태 없는 서버 컴포넌트라 클라이언트 카드 안에서도 그대로 쓴다) · `MarketExtrasPanel.tsx`(수급·컨센서스·자사주 — 카드를 펼치면 `/api/kr-extras`로 받아 그린다. **국내 종목 전용**이고, 세 값 모두 기존 판정·점수에 넣지 않고 나란히 보여주기만 한다 — 점수에 섞으면 왜 그 점수인지 알 수 없게 되고 지금까지 쌓인 스크리너 성적과 기준이 갈라진다) · `LazyStockChart.tsx`(펼쳤을 때 일봉을 받아 그리는 차트) · `AverageCostCalculator.tsx`(분할매수 평단 계산기 — 포지션 관리 카드를 펼치면 나온다. **차수별 매수 내역은 브라우저 localStorage에만** 두고, 계산된 평단가만 버튼으로 `watchlist_tickers.avg_cost`에 올린다 — 매수 기록은 기기에서 끝나는 개인 메모라 스키마를 늘릴 이유가 없고 파이프라인도 안 쓰는 반면, 손익률 표시는 다른 기기에서도 보여야 하기 때문. 카드를 펼쳐야만 마운트되므로 첫 렌더에서 localStorage를 바로 읽어도 SSR 불일치가 없다) · `StockCard.tsx`(눌림목 카드) · `StockChart.tsx`(lightweight-charts, lazy load. **RSI를 켜면 차트가 두 개가 되는데 반드시 묶어 둘 것** — v4에는 한 차트 안에 패널을 나누는 기능이 없어 `createChart`를 두 번 부를 수밖에 없고, 그냥 두면 위를 확대·이동해도 아래 RSI는 가만히 있어 **같은 날짜를 보고 있다는 보장이 없다**(실제로 위는 2~7월, 아래는 3~4월을 보여주고 있었다, 2026-09-15). 지금은 ① 보이는 범위(`subscribeVisibleLogicalRangeChange` ↔ `setVisibleLogicalRange`, **재진입 깃발 필수** — 없으면 둘이 서로를 끝없이 밀어댄다) ② 십자선(`subscribeCrosshairMove` ↔ `setCrosshairPosition`) ③ 가격축 폭(넓은 쪽에 맞춰 `minimumWidth` 고정, 안 맞추면 같은 날짜가 위아래로 어긋나 보인다)을 묶고, 위 차트의 시간축을 숨겨 아래 축 하나를 공유한다. **RSI 워밍업 구간(앞 14봉)을 `filter`로 버리면 안 된다** — 두 차트의 봉 개수가 달라져 같은 논리 인덱스가 다른 날짜를 가리키고, 그러면 범위 동기화가 어긋난 채 맞은 것처럼 보인다. 값이 없는 봉은 빈 점(whitespace, `{ time }`만)으로 넣는다) ·
`WatchlistCard.tsx`(매집 감시 카드) · `PositionCard.tsx`(포지션 관리 카드 — 보유 종목 지지 신호 점검,
`supportSignals.ts` 사용) · `Scorecard.tsx`(성적 판정·구간별 막대)/`PerformanceTable.tsx`/`ExitSignalTable.tsx`
(스크리너 성적·포지션) · `LeadingSectors.tsx` · `MarketRegimeBadge.tsx` ·
`RealestateMediaSection.tsx`(부동산 홈 상단 뉴스·영상, 데이터 없으면 섹션째 숨김) ·
`EtfWatchCard.tsx`(490590 매수체크 화면 렌더 — 계산은 `lib/etfEntryCheck.ts`가 서버 컴포넌트에서
미리 끝내고 결과만 받는다. 몇 차까지 매수를 실행했는지는 `AverageCostCalculator.tsx`와 같은 원칙으로
브라우저 localStorage에만 저장)

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
- **감시 목적 분리(2026-09-06)**: 같은 `watchlist_tickers` 테이블이지만 `category`로 두 갈래다.
  파이프라인(`watchlist.py`)은 **category를 모른 채 전 종목을 평가**하므로, 포지션 관리
  종목의 매집 판정 행(`watchlist_status`)도 그대로 쌓인다 — 화면 쪽(`app/discover/page.tsx`의
  `loadAccumulationWatchlist`)이 그 행을 걸러내야 같은 종목이 두 화면에 겹쳐 뜨지 않는다.
  category를 파이프라인까지 내리지 않은 건, 포지션 관리 카드가 파이프라인 판정을 전혀
  안 쓰고 일봉만으로 프론트에서 계산하기 때문(`supportSignals.ts`)
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
- **화면에 안 쓰는 일봉을 미리 내려보내지 말 것 (2026-09-10)**: 예전에는 화면에 뜨는
  모든 종목의 일봉이 서버 렌더 결과(RSC 페이로드)에 실려 브라우저까지 갔다. 정작 그걸
  쓰는 건 차트뿐이고 차트는 카드를 펼쳐야 뜨므로, 대부분이 한 번도 안 쓰이고 버려졌다 —
  탭 전환이 느린 가장 큰 원인이었다(눌림목 종목당 150봉, 종목발굴 감시 종목 30개 ×
  500봉). 지금은 `/api/price-history` + `useLazyPriceHistory`/`LazyStockChart`로 펼친
  종목만 받는다. **카드에 새 데이터를 붙일 때 같은 실수를 반복하지 말 것** — 펼쳐야
  보이는 정보는 펼쳤을 때 받는다(`/api/kr-extras`도 같은 이유로 라우트다). 서버에서만
  필요한 계산(등락률·손익비)은 서버에서 끝내고 숫자만 내려보낸다.
  **다만 "다 보내지 말라"는 교훈이지 "아무것도 보내지 말라"가 아니다** — 종목당
  숫자 몇 개짜리 요약(`getKrExtrasSummaries`)은 미리 보내는 게 맞다. 실제로 새
  기능 3종을 전부 펼침 안에 넣었더니 "사이트가 그대로인데?"라는 말을 들었다
  (2026-09-10). 무거운 건 펼쳤을 때, 요약은 접힌 채로
- **자사주 진행률은 네 종류이고 절대 합치지 않는다 (2026-09-11 갱신)**: ⓪
  `confirmed_progress_pct`(**거래소 체결내역 확정**, `trstk.py`) ①
  `amount_progress_pct`(취득 금액 확정, 결과보고서 기반) ② `estimated_progress_pct`
  (위탁증권사 창구 누적 순매수 기반 **추정**) ③ `period_progress_pct`(취득 기간
  경과율, 마지막 수단). 근거를 고르는 규칙은 `frontend/lib/buybackProgress.ts`
  **한 곳**에 있고 배지·상세가 같이 쓴다 — 각자 고르면 같은 종목인데 다른 숫자를
  말한다. ①은 DART에 정형 API가 없어 지금은 거의 안 채워진다.
  **②는 관측 일수를 반드시 따져야 한다**: 거래원은 과거 소급이 안 돼 수집 시작일부터
  쌓이는데, SK하이닉스는 8/20에 40조원 취득을 시작했고 수집 첫날 관측한 SK증권
  순매수가 1.16조원이라 그대로 나누면 **2.9%**가 나왔다. 그건 "회사가 3%만 샀다"가
  아니라 "우리가 하루만 봤다"는 뜻인데 숫자만 보면 정반대로 읽힌다. 그래서
  커버리지(관측일 ÷ 경과 거래일)가 `MIN_ESTIMATE_COVERAGE`(50%) 미만이면 ②를
  대표로 쓰지 않고 ③으로 내려간다.
  **ⓘ ⓪이 생기면서 ②·③은 차선책으로 내려갔다 (2026-09-11)**: KRX KIND
  `/api/trstk/traded`가 일자별 체결수량을 그대로 주므로, 체결내역이 잡히는 종목은
  결과보고서를 기다릴 필요도 창구로 추정할 필요도 없다. **⓪은 커버리지를 따지지
  않는다** — 소급되는 소스라 "하루만 봤다"는 상태 자체가 없기 때문이다.
  ②·③은 체결내역이 아직 없는 종목(취득 기간 시작 전 등)의 차선책으로 남긴다.

  **③으로 내려갔을 때 퍼센트를 진행률 자리에 그대로 놓으면 안 된다** — 2026-09-11에
  기간 경과 23%를 보고 "자사주를 23% 샀구나"로 읽혔다. %를 진행률 자리에 놓는 순간
  사람은 매입량으로 읽는다. 그래서 `BuybackBasis.measuresPurchase`로 "이게 매입량을
  재는 값인가"를 구분하고, false면 배지는 퍼센트 없이 '자사주 매입중'만, 상세는
  진행바를 옅게 그리고 "달력이 얼마나 지났는지일 뿐"이라고 명시한다
- **성적이 두 갈래다 (2026-09-14)**: `frontend/lib/scorecard.ts`는 **눌림목**(손절·목표가가
  있으므로 손익을 R로 잰다), `frontend/lib/patternScorecard.ts`는 **저점 매집 후보**(손절·목표를
  계산하지 않으므로 보유 수익률 %로 잰다). 둘 다 `app/history` 한 페이지에 나란히 있지만
  **상수를 공유하지 않는다** — `MAX_HOLD_BARS`와 `PATTERN_HOLD_BARS`는 값이 60으로 같아도
  근거가 다르다(스윙 보유 기간 vs 바닥 탈출 관찰 기간). 한쪽 화면의 호흡을 바꾼다고 다른 쪽
  판정 기간이 따라 움직이면 안 된다. 막대 표(`DivergingBarTable`)와 판정 배지(`VerdictBadge`)만
  공유한다 — 그쪽은 폰 화면용 폭 조정이 들어 있어 복사하면 한쪽만 고쳐진다.
  **저점 매집 후보 성적에는 벤치마크가 없다** — 같은 기간 지수 수익률과 비교해야 맞지만
  `market_index_snapshot`이 지수당 1행(현재 시황용)이라 과거 시계열이 없다. 그래서 지금은
  승률 50%를 눈금으로 쓰고, 화면에 "이 숫자만으로 시장보다 나았다고는 말할 수 없다"고 밝혀 둔다
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

- **US 유니버스의 Russell 3000은 네이버 증권 API에서 온다**(2026-09-09 교체). 지수 자체는
  FTSE Russell이 유료로만 배포해서 이를 추종하는 ETF의 공개 보유종목 파일에 의존해 왔는데
  그게 전부 막혔다 — 프로브(`.github/workflows/universe_probe.yml`, `python -m
  src.universe_us`)로 7종을 두드려 본 결과: iShares IWV는 마케팅 페이지, Vanguard VTHR은
  앱 셸 HTML(둘 다 HTTP 200이라 조용히 실패했다), stockanalysis 러셀 목록·스크리너 API는
  404, 위키백과 Russell 1000은 표 없음, FDR 상장목록과 KIS 마스터는 받아지지만 **시총 칸이
  없어** 상위 3,000개를 못 자름, stockanalysis 전체목록은 서버가 500개만 렌더(알파벳 앞쪽이라
  NVDA·MSFT가 빠진다).
  **유일하게 통한 건 네이버 증권 앱의 해외주식 API**(`api.stock.naver.com/stock/exchange/
  {NASDAQ|NYSE|AMEX}/marketValue`)다 — 시가총액 내림차순으로 페이지 단위로 주므로 "미국 상장
  시총 상위 3,000개"(= Russell 3000의 정의)를 그대로 만들 수 있다. 키가 필요 없다.
  ADR(TSM 등)이 섞이지만 이 목록의 용도가 패턴 발굴 커버리지 확장이라 문제되지 않는다.
  소스를 새로 쓸 때 **시총 칸이 있는지 먼저 볼 것** — 없으면 상위를 못 잘라 6,000개가 통째로
  들어와 일봉 수집 시간이 두 배가 된다. `_RUSSELL_SOURCES`에 한 줄 추가하고 프로브를 돌리면
  1분 만에 확인된다(universe_us.py를 건드리면 자동 실행된다)
- **장세 날짜 ≠ 종목 날짜 (2026-09-09 사고)**: `market_regime`·`leading_sectors`의 날짜는
  **지수 시계열의 마지막 날짜**(`pipeline.py`의 `as_of`)에서, `screened_stocks`의 날짜는
  **그 종목 일봉의 마지막 날짜**에서 나온다. 둘이 어긋날 수 있다 — 코스피 지수를 fdr 캐시로
  받던 탓에 장세는 9/7, 종목은 9/9로 저장돼 눌림목 탭이 통째로 비었다(화면이 장세 날짜로
  종목을 찾았기 때문). 두 가지로 막아뒀다: (1) `prices_kr.get_kospi_index_history`가
  네이버 `siseJson` → yfinance → fdr 순으로 떨어진다 — `market_indices.py`와 같은 소스·같은 장중 봉 처리라
  **한쪽을 바꾸면 다른 쪽도 같이 볼 것**, (2) 화면(`app/pullback/page.tsx`)은 장세 날짜가
  아니라 `getLatestScreenedDate()`로 **종목 쪽 최신 날짜**를 찾아 조회한다. 미장은 지수가
  yfinance(현지 날짜), 종목이 KIS(한국 날짜) 기준이라 구조적으로 하루 어긋날 수 있으므로
  (2)가 없으면 언제든 다시 빈다.
  DB에 어느 날짜로 몇 행 들어가 있는지는 `.github/workflows/db_probe.yml`
  (`python -m src.db_probe`)로 1분 만에 확인된다 — 화면이 하는 조회를 그대로 재현해 준다.
  **감시 종목도 여기서 본다 (2026-09-15 추가)**: `watchlist_tickers` 행 수·최근 추가 종목,
  일봉이 0봉인 종목 목록, 그리고 최근 추가 종목의 총 봉 수와 실제 OHLCV 5개를 찍는다.
  "사이트에서 추가했는데 안 뜬다"는 신고가 들어왔을 때 **어디까지 됐는지를 가르는 유일한
  수단**이다 — 목록에 있음(insert 성공) / 일봉 0봉(백필 전) / 66봉 미만(일봉은 있는데
  화면은 "판정 불가") / 값이 이상함(차트가 빈 화면)이 전부 다른 문제인데 화면에서는
  똑같이 "안 뜬다"로 보인다. 실제로 2026-09-15에 490590이 30개 상한에 걸려 insert 자체가
  거절되던 것을 이걸로 잡았다
- **부동산 개요의 "기준월"**: 실거래 신고 기한이 30일이라 **이달 초에는 매매 신고가 0건인
  지역이 흔하다**(전월세는 바로 들어와 행 자체는 생기고 `price_avg`만 null). 그 행을 최신월로
  잡으면 그 지역만 매매가·전월대비가 '—'로 뜨고 목록 맨 아래로 밀려서 "업데이트 안 됨"으로
  보인다(2026-09 서울 일부 구·광명시 사례). `realestateTrend.ts`의 `regionOverview`는 그래서
  **매매 거래가 실제로 있던 마지막 달**을 최신월로 쓴다 — 어느 달 기준인지는 표의 '기준월'
  열에 그대로 나오므로 숨기는 게 아니다. 지도(`mapPriceByCode`)도 이 값을 쓰므로 같이 고쳐진다
- **부동산 페이지네이션 정렬**: `getRealestateMonthly`는 `(region_code, month, area_band)`
  **세 개 전부로** 정렬해야 한다. 앞 두 개만 쓰면 같은 달의 구간 행 5개가 동순위라 페이지마다
  순서가 달라질 수 있고, 그러면 1,000행 경계에 걸친 행이 조용히 빠지거나 두 번 들어온다
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

## 보고 규칙 — 확인된 것과 추측을 절대 섞지 말 것

**추측을 사실처럼 말하지 않는다.** 모르면 "모른다", 확인이 필요하면 "확인해 보겠다"고
말한다. 이건 말투 문제가 아니라 **작업이 잘못된 전제 위에 쌓이는 것을 막는 장치**다.

2026-09-11에 실제로 그렇게 틀렸다. 사용자가 준 KIND 접수번호(`acptNo=20260826000780`)를
DART `document.xml`에 넣었더니 200에 293,832자가 왔다. 그걸 보고 **"KIND 접수번호와
DART 접수번호가 같은 번호였습니다"**라고 단정했다. 확인해 보니 그 문서는
`<COMPANY-NAME> NH투자증권(주)` / `<DOCUMENT-NAME> 투자설명서(일괄신고)`로
**자기주식과 무관한 서류**였다. 번호 체계가 같다는 근거는 어디에도 없었다 —
"응답이 200이다"에서 "같은 번호다"로 건너뛴 것뿐이다.

컨센서스에서 세 번 연속 틀린 것도 정확히 같은 실수였다(초록불 + 그럴듯한 숫자 =
맞는 값이라고 단정). **"응답이 왔다"와 "맞는 값이다"는 다르다.**

그래서 보고할 때는 이렇게 나눈다.

| 쓸 수 있는 말 | 근거 |
|---|---|
| "확인됐다" | 프로브 출력에 그 값이 실제로 찍혔을 때만 |
| "~로 보인다 / 확인해 보겠다" | 정황은 있으나 안 찍어봤을 때 |
| "모르겠다" | 근거가 없을 때 |

값을 봤다면 **그 값을 그대로 인용**한다(상태 코드·문자 수·응답 본문). 요약해서
옮기는 순간 추측이 섞인다.

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
- ~~수급·컨센서스·자사주 소스 미검증~~ — **2026-09-10 프로브로 3/3 확인 완료**
  (`KR Market Extras Source Probe`). 확인된 사실과 그 과정에서 드러난 함정:
  - **수급**: 네이버 금융 `item/frgn.naver` 정상. 종목당 60행(3페이지).
    EUC-KR 인코딩을 지정해야 컬럼명이 안 깨진다
  - **컨센서스**: 값이 있는 곳은 네이버가 아니라 **WISEreport 기업개요**다
    (네이버 종목 화면이 iframe으로 끼워 넣는 페이지). 모바일 API에는 목표주가
    필드가 아예 없다. 표는 15개 중 11번째이고 구조는
    `['4.05','투자의견','목표주가(원)','EPS(원)','PER(배)','추정기관수']` /
    `['4.05','4.05','488409','48239','5.59','22']` — **헤더가 행이고 값이 그 아래
    행**이다. 그래서 `_consensus_from_table`은 '투자의견'과 '목표주가'가 **함께**
    있는 표로 한정하고 열을 헤더 이름으로 찾는다. 투자의견은 1~5 점수라 한글
    라벨을 붙여 저장한다("매수 4.05")
  - **자사주**: `tsstkAqDecsn`(취득)·`tsstkDpDecsn`(처분) 정상. 신탁계약
    체결(`tsstkAqTrctrCnsCnc`)은 **그런 엔드포인트가 없다**(status=101).
    날짜가 `"2026년 03월 19일"` 형식이고, 금액은 보통주·기타주식이 따로 온다.
    `list.json`은 **최신순**으로 주므로 `[-1]`은 가장 오래된 공시다
  - **취득 완료 금액은 이 API에 없다**. 주요사항보고서는 "얼마를 사겠다"는 계획
    공시이고 실제 체결량은 자기주식취득결과보고서(전용 API 없음)에 있다.
    → **2026-09-10 후속**: `buyback_probe.py`로 두 우회로를 확인했다. (1) DART
    공시서류원본파일(`opendart.fss.or.kr/api/document.xml`)은 **지금 키 그대로**
    ZIP+XML을 내려준다(SK하이닉스 3.5KB, 삼성전자 6KB, UTF-8, '취득금액' 문구 존재).
    다만 `<TABLE ACLASS="EXTRACTION">` 같은 DART 전용 태그라 표 파싱에 `html5lib`이
    필요하고, 결과보고서 자체가 프로그램이 **끝난 뒤** 나와서 진행 중에는 못 쓴다.
    (2) **네이버 거래원**이 실질적인 답이다 — 취득 결정 공시의 위탁투자중개업자
    (`cs_iv_bk`)와 창구별 순매수를 이으면 진행 중에도 추정할 수 있다(`broker_flow.py`).
    실측으로 SK하이닉스 매수상위 1위가 SK증권 623,600주였다.
    **단 이 페이지는 시간대를 탄다** — 같은 URL이 17:07 KST에는 거래원 표를 주고
    (191,475자) 21:57 KST에는 안 줬다(117,909자, '매수상위' 문구 자체가 없음).
    수집이 17:30에 도는 건 맞는 시각이지만, 실패하면 **그날은 영영 구멍**이 난다
    (소급 불가). `_broker_table`이 "페이지가 안 준다"와 "구조가 바뀌어 못 읽는다"를
    다른 사유로 구분해 두는 이유다. 밤에는 lxml이 실패하고 html5lib을 요구하는 것도
    확인해 `requirements.txt`에 html5lib·beautifulsoup4를 직접 걸었다.
    **KRX 정보데이터시스템으로 과거를 소급하려던 시도는 실패했다** — `getJsonData.cmd`에
    bld 후보 4개를 두드려 전부 400이다(`buyback_probe.py`의 `_KRX_CANDIDATES`).
    → **2026-09-11: 진짜 소스가 무엇인지는 확인됐다.** 사용자가 보여준 화면(raoni.xyz)의
    출처 표기가 **"KRX KIND 자기주식매매 신청/체결내역 공시"**였다. 거기엔 일자별
    신청·체결 수량이 그대로 공시되어 **추정이 아니라 확정치이고 소급도 된다**
    (SK하이닉스 누적 43.0% = 10,350,000/24,070,000주, 17영업일, 평균 체결단가
    1,712,568원). 규칙도 그 화면에서 배웠다 — 신청량은 전영업일 저녁에, 체결량은
    18시 이후에 공시되고, 1일 매수한도는 취득예정의 10%다.
    **다만 수집 경로는 아직 못 뚫었다.** KIND는 `searchtotalinfo.do`·`details.do`가
    200을 주지만 내용은 "페이지 오류" 안내이고(파라미터 불명), 나머지 후보는 404,
    모바일(`mkind.krx.co.kr`)도 `.do`·`method` 추출이 0건이다. KRX는 작업 컨테이너와
    GitHub Actions 양쪽에서 브라우저 없이는 안 열려 Playwright도 못 쓴다.
    → **2026-09-11 해결: 경로를 뚫었다.** `trstk.py`가 쓰는 경로는
    **`GET https://mkind.krx.co.kr/api/trstk/traded`**다. 실측으로 SK하이닉스가
    8/20 이후 17영업일간 매일 650,000주를 체결한 것이 그대로 나온다:

        {'tot_cnt': 17, 'rep_isu_srt_cd': '000660', 'com_abbrv': 'SK하이닉스',
         'trd_dd': '20260904', 'trstk_appl_qty': '650000',
         'trstk_trd_qty': '650000', 'trstk_acqstdisp_tp_cd': '1', ...}

    찾기까지 네 번 헛짚었다. **같은 길을 다시 파지 않도록 실패 이유를 남긴다.**

    (a) **확장자를 전제하지 말 것.** `.do`만 찾다 0건, `.do|.js|.json|.cmd`로 넓혀도
    0건. 확장자를 아예 버리자 `/api/...`가 나왔다. 문제는 "어떤 확장자냐"가 아니라
    "확장자로 찾는다"는 전제였다.

    (b) **PC KIND는 `?method=`를 줘야 열린다.** 맨손으로 `main.do`를 부르면 404가
    아니라 **200 + "페이지 오류" 안내**라서 "막혔다"고 오해했다. 사용자가 준 뷰어
    주소(`common/disclsviewer.do?method=searchInitInfo&acptNo=...`)가 이걸 알려줬고,
    정식 입구를 두드리니 **메뉴 HTML이 통째로** 나왔다 — 거기에
    `/corpgeneral/treasurystk.do`와 모바일 자사주 라우트
    (`trstk-declared`/`trstk-applied`/`trstk-traded`)가 다 있었다.
    **메뉴에 안 보여도 화면은 존재한다**(사용자가 "메뉴에 자기주식이 없다"고 확인해
    준 것과 모순되지 않는다).

    (c) **400과 404는 전혀 다르다.** 틀린 주소(`/api/trstk-traded`)는 404 + HTML,
    맞는 주소는 **400 + JSON `{"resultCode":"E0002","message":"파라미터 검증 실패"}`**였다.
    400을 받았다면 주소는 맞은 것이고 조건만 모르는 상태다. 그 조건 이름은 화면
    소스의 `searchTrstkList()`에 그대로 적혀 있었다.

    (d) **번들의 한글은 `\uXXXX`로 이스케이프돼 있다.** 원문으로 '자기주식'을
    찾으면 영원히 0건이다. 찾기 전에 이스케이프를 풀 것.

    (e) **천천히 두드릴 것.** 한 실행에서 번들 80개 + `/api` 40개 + 화면 4개,
    **130여 회**를 연달아 쏘고 403을 맞았다 — 몇 분 전까지 열리던 주소까지 전부.
    정작 필요한 건 20영업일치라 스무 번이면 됐다. 세션(쿠키) + 요청 간격 +
    호스트에 맞는 Referer로 바꾸니 다시 열렸다.

    **DART로 우회하는 길은 없다**(확인 완료). 사용자가 준 접수번호를 DART
    `document.xml`에 넣으면 200에 293,832자가 오지만, 그 문서는
    `<COMPANY-NAME> NH투자증권(주)` / `<DOCUMENT-NAME> 투자설명서(일괄신고)`로
    자기주식과 무관하다 — **KIND acptNo와 DART rcept_no는 같은 번호가 아니다.**
    DART 목록에도 일별 신청/체결 공시는 없다(거래소공시 `pblntf_ty=I`로 좁혀도
    SK하이닉스 30일치 8건뿐, 해당 없음).

- **프로브의 교훈: "성공했다"와 "맞는 값이다"는 다르다.** 컨센서스는 세 번이나
  초록불로 끝나면서 틀린 칸을 읽고 있었다(투자의견을 '목표주가원'이라는 헤더
  텍스트로 읽음). 값이 숫자이고 범위 안이라는 검사로는 안 잡힌다. 그래서
  프로브는 (1) 수급에서 받은 **현재가로 목표가를 검산**하고, (2) 성공했을 때도
  **표 구조를 통째로 찍는다**. 새 HTML 소스를 붙일 때 같은 함정을 조심할 것
- ~~`supabase/recommendation_history_features.sql`을 실행할 것~~ — **2026-09-14 실행 완료**
  (사용자 확인). `recommendation_history`에 추천 시점 특성(점수·하락률·저점 유지 일수·
  거래량비·VCP·이평·거래량 트리거·저점 높이기) 컬럼이 들어갔다. **컬럼이 있는 것과 값이
  차 있는 것은 다르다** — 과거 행은 소급되지 않으므로(`pattern_match_results`가 매 실행
  전체 삭제라 지난 추천의 근거가 어디에도 안 남는다) 실행일 **이후** 추천부터만 채워진다.
  실제로 들어갔는지·값이 쌓이는지는 `.github/workflows/db_probe.yml`
  (`python -m src.db_probe`)이 찍어 준다 — **다른 데서는 티가 안 난다**:
  `save_recommendation_history`가 컬럼 없음을 감지하면 기본 컬럼으로 다시 저장하므로
  실행 로그는 초록불이고, 성적 화면은 특성별 표만 조용히 빈다
- **`supabase/pattern_match_results_drawdown.sql`을 실행할 것** (2026-09-15 추가).
  `pattern_match_results`에 `drawdown_pct` 열을 더한다 — 저점 매집 후보 카드의
  **⏳ 권장 관찰 기간 배지**(3개월 / 3~12개월 / 1년)가 이 값으로 붙는다.
  **백필은 필요 없다** — 이 표는 파이프라인이 매 실행마다 통째로 지우고 다시 쓰므로
  (`recommendation_history`와 다른 점) SQL만 실행하면 다음 실행부터 전부 채워진다.
  안 해도 화면은 안 깨진다(값이 null이면 배지만 안 붙는다) — 그래서 **조용히 빠진다.**
  `save_pattern_matches`도 열이 없으면 기본 열로 다시 저장해 로그는 초록불이다

- **`supabase/etf_holdings.sql`을 실행할 것** (2026-09-25 추가). 490590 구성종목을 담는
  표다. 안 하면 수집이 실패하고 화면은 **코드에 적어둔 낡은 폴백 목록**으로 계산한다 —
  다만 그 사실을 화면이 "⚠ 자동 수집 값이 아직 없어 …로 계산했습니다"로 밝히므로
  조용히 틀리지는 않는다. 실행 후 `.github/workflows/etf_holdings.yml`을 한 번
  수동 실행하면 바로 채워진다
- **`supabase/kr_market_extras.sql`을 실행할 것.** 이미 실행했다면 파일 맨 아래의
  **`buyback_trades` 표 + `confirmed_*` 열**만 더 실행하면 된다(2026-09-11 추가).
  이걸 안 하면 체결내역 수집이 통째로 건너뛰어지고(본체는 계속 저장된다) 화면은
  예전처럼 기간 경과율만 보여준다
- **수집 워크플로는 기본 브랜치에 있어야 스케줄이 돈다.** GitHub Actions의
  `schedule`·`workflow_dispatch`는 기본 브랜치의 워크플로 파일만 본다 —
  `kr_market_extras.yml`이 master에 병합되기 전까지 평일 17:30 자동 실행은
  일어나지 않는다(프로브는 `push` 트리거라 브랜치에서도 돈다)
