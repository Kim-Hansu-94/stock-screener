-- Supabase SQL 에디터에서 1회 실행.
-- 2026-07-08 스케줄 파이프라인이 마지막 단계 refresh_monthly_ohlcv() RPC에서
-- "canceling statement due to statement timeout"(8초)으로 실패했다.
-- REFRESH MATERIALIZED VIEW CONCURRENTLY가 데이터 증가로 8초를 넘긴 것.
-- 함수에 SET statement_timeout을 붙이는 방식은 이미 실행 중인 상위 문장의
-- 타이머를 재설정하지 못하므로(Postgres 특성) role 단위로 올린다.
-- service_role 키는 파이프라인과 프론트 서버에서만 쓰므로 외부 노출 위험 없음.
alter role service_role set statement_timeout = '2min';

-- PostgREST가 role 설정을 다시 읽도록 알린다.
notify pgrst, 'reload config';
