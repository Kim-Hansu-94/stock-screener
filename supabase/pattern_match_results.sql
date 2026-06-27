-- Supabase 대시보드 SQL Editor에서 한 번만 실행하세요.
-- 파이프라인이 매일 Gold Standard 패턴 매칭 결과를 저장하는 테이블입니다.

create table if not exists pattern_match_results (
  id              bigserial primary key,
  rank            integer not null,
  ticker          text    not null,
  name            text    not null,
  sector          text,
  similarity      double precision not null,
  matched_standard         text not null,
  matched_standard_ticker  text not null,
  matched_bottom           text not null,
  volume_triggered boolean not null default false,
  close           double precision,
  computed_at     text not null
);

-- 프론트엔드가 rank 순으로 조회하므로 인덱스 추가
create index if not exists idx_pattern_match_rank on pattern_match_results (rank);
