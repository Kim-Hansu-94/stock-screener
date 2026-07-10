-- S&P 500 조정 매수 탭용 테이블 (spec: docs/superpowers/specs/2026-07-10-sp500-dca-tab-design.md)

-- 지수 일봉 + 계산값. stage/cycle_id는 파이프라인이 확정해 저장하고 프론트는 읽기만 한다.
create table if not exists sp500_daily (
  date date primary key,
  close numeric not null,
  high_52w numeric not null,
  drawdown_pct numeric not null,
  stage int not null check (stage between 0 and 4),
  cycle_id int not null,
  rsi_w numeric,          -- 주봉 RSI(14), 참고 지표
  ma20_m_gap numeric,     -- 월봉 20이평 이격도 %
  ma200_d_gap numeric     -- 200일선 이격도 %
);

-- 단계 진입 이벤트. 사이클당 단계별 1개가 불변이므로 (cycle_id, stage) PK로 upsert 멱등.
create table if not exists sp500_signals (
  cycle_id int not null,
  stage int not null check (stage between 1 and 4),
  date date not null,
  index_close numeric not null,
  drawdown_pct numeric not null,
  primary key (cycle_id, stage)
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
