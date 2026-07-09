-- Supabase SQL 에디터에서 1회 실행.
--
-- 눌림목 스크리너를 통과/탈락 이분법에서 랭킹 방식으로 전환:
-- 전 조건 통과 종목이 없는 날에도 미달 조건이 가장 적은 상위 후보를
-- 저장·표시한다 (매일 볼 것이 있도록).
--
-- passed: 전 조건 통과 여부. 기존 행은 모두 통과 종목이었으므로 default true.
-- failed_criteria: 미달 조건 라벨 목록 (예: '거래량 미감소', '시장 하락장').
--   이력/성적표/보유점검 집계는 passed = true 행만 사용해 기존 의미를 유지한다.
alter table screened_stocks
  add column if not exists passed boolean not null default true,
  add column if not exists failed_criteria text[] not null default '{}';
