-- Supabase SQL 에디터에서 1회 실행.
--
-- 배경: KR 재무건전성(유동비율·부채비율, stock_fundamentals_financial_health.sql)에
-- 이어 US도 채운다. US(yfinance)는 대차대조표 조회(ticker.balance_sheet)가
-- 실적 조회(ticker.income_stmt)와 별도 호출이라 종목당 요청이 두 배가 된다 —
-- 매일 도는 실적 수집(06:30 KST 본 파이프라인)에 얹지 않고, us_financial_health_main.py가
-- 21:00 KST 전용 워크플로에서 같은 30일 주기로 독립 수집한다.
--
-- financial_health_updated_at을 실적용 updated_at과 분리하는 이유: 같은 컬럼을
-- 쓰면 재무건전성만 갱신했을 때도 updated_at이 찍혀, fundamentals.py의
-- _stale_tickers가 "실적도 최근에 갱신됐다"고 착각해 진짜 실적 갱신을 건너뛴다.

alter table stock_fundamentals
  add column if not exists financial_health_updated_at date;

-- 기존 US 행(재무건전성 컬럼이 이미 null인 행들)은 이 마이그레이션으로 바뀌는 게
-- 없다 — us_financial_health_main.py 첫 실행부터 자연스럽게 채워진다. 별도 백필 불필요.
