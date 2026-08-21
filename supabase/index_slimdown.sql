-- Supabase SQL 에디터에서 1회 실행 (한 줄씩, 트랜잭션 밖에서).
--
-- 왜: DB 500MB 중 426MB를 쓰고 있고, 그중 146MB가 idx_sph_daily_bars 하나다.
-- 이 인덱스는 close/high/low/volume을 전부 INCLUDE해 사실상 테이블 사본이며,
-- 원래 목적이던 프론트 getDailyBars 쿼리는 opportunity_snapshot 사전 계산으로
-- 대체되면서 코드에서 사라졌다. 지금 이 인덱스를 쓰는 건 파이프라인의
-- get_opp_drawdowns뿐이고, 그건 close 하나만 읽는다.
--
-- ⚠️ 순서 주의: 반드시 DROP을 먼저 한다.
--    새 인덱스를 먼저 만들면 빌드 중 두 인덱스가 공존해 순간 사용량이
--    500MB를 넘어 쓰기가 막힐 수 있다(426 + 80 > 500).
--    DROP과 CREATE 사이에는 커버링 인덱스가 없어 조정폭 집계가 느려지므로,
--    파이프라인이 도는 시각(06:30 / 16:30 KST)을 피해서 실행할 것.

-- 1) 사본에 가까운 큰 인덱스 제거 (즉시 146MB 반환 — 인덱스는 VACUUM 없이 바로 회수된다)
drop index concurrently if exists idx_sph_daily_bars;

-- 2) get_opp_drawdowns 전용 최소 커버링 인덱스 (close만, 약 80MB 예상)
create index concurrently if not exists idx_sph_market_ticker_date_close
  on stock_price_history (market, ticker, date) include (close);

-- 확인용 — 실행 후 크기 재측정
-- select
--   relname,
--   pg_size_pretty(pg_relation_size(oid)) as size
-- from pg_class
-- where relname in ('stock_price_history', 'idx_sph_daily_bars',
--                   'idx_sph_market_ticker_date_close', 'stock_price_history_pkey')
-- order by pg_relation_size(oid) desc;
