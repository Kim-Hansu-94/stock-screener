-- S&P 500 적립 탭용 테이블 (spec v2: docs/superpowers/specs/2026-07-10-sp500-dca-tab-design.md)
-- 전략: TIGER 미국S&P500(360750) 매월 정기 매수. 조정 정보는 참고 표시 전용.

-- 지수 참고 데이터 (시장 현황 섹션). 파이프라인이 매일 upsert.
create table if not exists sp500_daily (
  date date primary key,
  close numeric not null,
  high_52w numeric not null,
  drawdown_pct numeric not null
);

-- 매수 기록. 프론트 서버 액션이 쓰고, 파이프라인은 건드리지 않는다.
create table if not exists sp500_purchases (
  id bigint generated always as identity primary key,
  date date not null,
  shares numeric not null check (shares > 0),
  price numeric not null check (price > 0),
  created_at timestamptz not null default now()
);

-- ETF 시세 (최신만 유지, 매일 덮어씀)
create table if not exists sp500_etf_quotes (
  ticker text primary key,
  name text not null,
  close numeric not null,
  change_pct numeric not null,
  currency text not null check (currency in ('KRW', 'USD')),
  as_of date not null,
  updated_at timestamptz not null default now()
);
