-- [4/5] 일봉 보관 3년 → 600일로 축소 + 실제 용량 회수
--
-- ⚠️ 순서: 1/5(백필) → 2/5(검증 0행) → 3/5(RPC 배포) → 파이프라인 1회 정상 실행
--         까지 끝난 뒤에 돌릴 것. 여기서부터는 되돌릴 수 없다(지운 일봉은 안 돌아옴).
-- ⚠️ 파이프라인이 도는 시각(06:30 / 16:30 KST)을 피할 것. VACUUM FULL이 테이블을
--    통째로 잠근다.
-- ⚠️ 한 줄씩 따로 실행할 것. VACUUM은 트랜잭션 안에서 못 돈다.
--
-- 왜 600일인가 — 일봉을 읽는 곳의 최대 요구치가 500일(opportunities.py의
-- BARS_DAYS)이고, 그 위로 100일 여유를 뒀다. 3년이 필요했던 유일한 곳인
-- 3년 고점은 3/5에서 월봉 기준으로 옮겼다.

-- ── ① 삭제 ───────────────────────────────────────────────────────────
-- 약 70만 행. 1~2분 걸릴 수 있다.
delete from stock_price_history
where date < (current_date - 600)::date;

-- ── ② 용량 회수 ──────────────────────────────────────────────────────
-- DELETE만으로는 파일 크기가 줄지 않는다(빈 자리로 남을 뿐). VACUUM FULL이
-- 테이블을 새로 써야 실제로 디스크가 돌아온다.
--
-- 쓰는 동안 "새 테이블 크기"만큼 여유가 필요하다. 지금 326MB / 한도 500MB이므로
-- 가능하지만, 용량이 더 차면 이 작업 자체를 못 하게 된다 — 그래서 지금 하는 것이다.
vacuum (full, analyze) stock_price_history;

-- ── ③ 월봉 MV 재계산 ─────────────────────────────────────────────────
-- 이제 MV는 600일 구간만 담는다. 그 이전은 stock_long_monthly가 맡고,
-- get_monthly_ohlcv(3/5)가 둘을 합쳐 돌려준다.
refresh materialized view concurrently mv_monthly_ohlcv;

-- ── ④ 결과 확인 ──────────────────────────────────────────────────────
select pg_size_pretty(pg_database_size(current_database())) as db_size;

select
  relname,
  pg_size_pretty(pg_total_relation_size(relid)) as total_size,
  n_live_tup as live_rows
from pg_stat_user_tables
order by pg_total_relation_size(relid) desc
limit 5;
