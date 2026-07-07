create table if not exists market_regime (
  date date not null,
  market text not null check (market in ('KR', 'US')),
  regime text not null check (regime in ('bull', 'bear')),
  primary key (date, market)
);

create table if not exists leading_sectors (
  date date not null,
  market text not null check (market in ('KR', 'US')),
  sector text not null,
  rank int not null,
  primary key (date, market, sector)
);

create table if not exists screened_stocks (
  date date not null,
  market text not null check (market in ('KR', 'US')),
  ticker text not null,
  name text not null,
  sector text not null,
  close numeric not null,
  market_cap numeric not null,
  rsi numeric not null,
  primary key (date, market, ticker)
);

create table if not exists stock_price_history (
  ticker text not null,
  market text not null check (market in ('KR', 'US')),
  date date not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume bigint not null,
  primary key (ticker, market, date)
);

-- Covering index for get_opp_drawdowns: it scans every universe ticker's 3-year
-- close history to compute the 3y high / latest close. INCLUDE (close) lets it
-- run as an index-only scan (no heap fetch), which is what keeps the KR path
-- (900+ KOSPI tickers, 600k+ rows) from hitting statement_timeout.
create index if not exists idx_sph_market_ticker_date_close
  on stock_price_history (market, ticker, date) include (close);

-- 월봉 사전 집계 Materialized View.
-- get_monthly_ohlcv가 매 호출마다 일봉을 윈도우 함수로 접던 비용(국장 635종목 기준
-- ~6.7초)을 리프레시 시점 1회로 옮긴다. 조회는 단순 인덱스 스캔이라 <1초로 떨어진다.
-- 파이프라인이 히스토리 저장 후 refresh_monthly_ohlcv()로 갱신한다.
create materialized view if not exists mv_monthly_ohlcv as
with base as (
  select
    s.ticker, s.market, s.date,
    s.open, s.high, s.low, s.close, s.volume,
    date_trunc('month', s.date)::date as month_start,
    row_number() over (
      partition by s.ticker, s.market, date_trunc('month', s.date)
      order by s.date asc
    ) as rn_asc,
    row_number() over (
      partition by s.ticker, s.market, date_trunc('month', s.date)
      order by s.date desc
    ) as rn_desc
  from stock_price_history s
)
select
  ticker, market, month_start,
  max(case when rn_asc  = 1 then open  end)::float8 as open,
  max(high)::float8                                  as high,
  min(low)::float8                                   as low,
  max(case when rn_desc = 1 then close end)::float8  as close,
  sum(volume)::bigint                                as volume,
  max(case when rn_desc = 1 then date  end)          as last_date
from base
group by ticker, market, month_start;

-- REFRESH ... CONCURRENTLY는 유니크 인덱스가 필수. 조회용 인덱스도 함께 둔다.
create unique index if not exists idx_mv_monthly_pk
  on mv_monthly_ohlcv (ticker, market, month_start);
create index if not exists idx_mv_monthly_lookup
  on mv_monthly_ohlcv (market, ticker, last_date);

-- 파이프라인에서 RPC로 호출. CONCURRENTLY라 갱신 중에도 조회가 막히지 않는다.
create or replace function refresh_monthly_ohlcv()
returns void
language plpgsql
as $$
begin
  refresh materialized view concurrently mv_monthly_ohlcv;
end;
$$;

create table if not exists stock_universe (
  ticker            text not null,
  market            text not null check (market in ('KR', 'US')),
  name              text,
  name_kr           text,
  sector            text,
  index_membership  text,
  updated_at        text not null,
  primary key (ticker, market)
);
-- 기존 배포에서 컬럼 추가 시 Supabase 대시보드 SQL 에디터에서 실행:
-- ALTER TABLE stock_universe ADD COLUMN IF NOT EXISTS name_kr text;

-- 월봉 OHLCV 집계 (Supabase max_rows=1000 우회용 RPC)
create or replace function get_monthly_ohlcv(
  p_market  text,
  p_tickers text[],
  p_cutoff  date
)
returns table (
  ticker text,
  market text,
  date   date,
  open   float8,
  high   float8,
  low    float8,
  close  float8,
  volume bigint
)
language sql
stable
as $$
  -- 사전 집계된 mv_monthly_ohlcv 조회 (윈도우 함수는 리프레시 시점에 이미 계산됨).
  select ticker, market, last_date as date, open, high, low, close, volume
  from mv_monthly_ohlcv
  where market  = p_market
    and ticker  = any(p_tickers)
    and last_date >= p_cutoff
  order by ticker, month_start
$$;

-- 3년 고점/현재가/행수를 티커별로 집계 (Supabase 기본 max_rows=1000 우회용 RPC)
create or replace function get_opp_drawdowns(
  p_market text,
  p_tickers text[],
  p_cutoff date
)
returns table(
  ticker text,
  high3y double precision,
  current_close double precision,
  row_count bigint
)
language sql stable
as $$
  select
    ticker,
    max(close)::double precision          as high3y,
    (array_agg(close order by date desc))[1]::double precision as current_close,
    count(*)                              as row_count
  from stock_price_history
  where market   = p_market
    and ticker   = any(p_tickers)
    and date    >= p_cutoff
  group by ticker
$$;
