-- index_slimdown.sql을 돌렸는데 용량이 그대로일 때 원인을 가려내는 진단.
-- SQL 에디터에 이 파일 전체를 붙여넣고 한 번에 실행해도 된다(읽기 전용).

-- ① stock_price_history에 붙어 있는 인덱스 목록 + 크기 + 유효 여부
--    - idx_sph_daily_bars가 아직 보이면 → DROP이 실패한 것
--    - valid = false가 있으면 → CREATE INDEX CONCURRENTLY가 실패해 남은 무효 인덱스
--      (용량만 먹고 쓰이지 않으므로 지워야 한다)
select
  i.relname                                as index_name,
  pg_size_pretty(pg_relation_size(i.oid))  as size,
  x.indisvalid                             as valid,
  pg_get_indexdef(i.oid)                   as definition
from pg_class t
join pg_index x on x.indrelid = t.oid
join pg_class i on i.oid = x.indexrelid
where t.relname = 'stock_price_history'
order by pg_relation_size(i.oid) desc;

-- ② DB 전체 크기 (대시보드 수치와 달리 실시간)
--    대시보드는 그대로인데 여기서 줄었다면 → 화면 반영이 늦은 것뿐이다.
select pg_size_pretty(pg_database_size(current_database())) as db_size;

-- ③ 죽은 행(부풀림) 확인
--    dead_rows가 크면 DELETE/UPDATE로 비운 공간이 파일에 그대로 남아 있는 것.
--    이건 VACUUM FULL을 해야 실제로 돌아온다.
select
  relname                                     as table_name,
  n_live_tup                                  as live_rows,
  n_dead_tup                                  as dead_rows,
  pg_size_pretty(pg_total_relation_size(relid)) as total_size,
  last_vacuum,
  last_autovacuum
from pg_stat_user_tables
order by pg_total_relation_size(relid) desc
limit 8;

-- ④ 일봉이 실제로 몇 년치 쌓여 있는지 (보관 정책이 도는지 확인)
--    3년(1095일)보다 오래된 행이 남아 있으면 자동 정리가 안 돌고 있다는 뜻 —
--    그러면 용량은 계속 늘기만 한다.
select
  extract(year from date)::int as year,
  count(*)                     as rows,
  min(date)                    as oldest,
  max(date)                    as newest
from stock_price_history
group by 1
order by 1;
