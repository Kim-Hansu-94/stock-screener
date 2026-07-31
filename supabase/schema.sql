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
  -- 랭킹 방식: passed=false 행은 전 조건 통과가 아닌 근접 후보(참고용).
  -- 이력/성적표 집계는 passed=true만 사용 (screened_stocks_ranking.sql 참고).
  passed boolean not null default true,
  failed_criteria text[] not null default '{}',
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
  -- 시가총액 (KR: 원, US: 달러). 파이프라인이 매일 갱신하며, 미확인 종목은 null.
  market_cap        numeric,
  updated_at        text not null,
  primary key (ticker, market)
);
-- 기존 배포에서 컬럼 추가 시 Supabase 대시보드 SQL 에디터에서 실행:
-- ALTER TABLE stock_universe ADD COLUMN IF NOT EXISTS name_kr text;
-- ALTER TABLE stock_universe ADD COLUMN IF NOT EXISTS market_cap numeric;

-- 장기(10년) 월봉. stock_price_history는 3년치만 보관하므로 그 이전 구간의 고점을
-- 볼 수 없어, 2021년 고점 같은 진짜 최고점이 조정폭 계산에서 통째로 빠졌다.
-- 과거 월봉은 확정된 값이라 변하지 않으므로 신규 종목만 1회 시드하고,
-- 최근 3년은 mv_monthly_ohlcv와 합쳐 읽는다 (pipeline/src/long_history.py).
create table if not exists stock_long_monthly (
  ticker       text not null,
  market       text not null check (market in ('KR', 'US')),
  month_start  date not null,
  open         numeric,
  high         numeric,
  low          numeric,
  close        numeric,
  volume       bigint,
  primary key (ticker, market, month_start)
);

-- 실적 요약. "주가가 빠질 때 실적도 같이 빠졌는가"를 판정하기 위한 최소 집합으로,
-- 가치 함정(실적 동반 하락)과 밸류에이션 조정(실적은 유지)을 구분하는 데 쓴다.
-- 분기 단위로만 바뀌므로 종목당 30일 주기로 갱신한다 (pipeline/src/fundamentals.py).
create table if not exists stock_fundamentals (
  ticker                   text not null,
  market                   text not null check (market in ('KR', 'US')),
  updated_at               date not null,
  fiscal_year_latest       int,
  fiscal_year_prior        int,
  revenue_latest           numeric,
  revenue_prior            numeric,
  operating_income_latest  numeric,
  operating_income_prior   numeric,
  net_income_latest        numeric,
  net_income_prior         numeric,
  eps_latest               numeric,
  eps_prior                numeric,
  per                      numeric,
  pbr                      numeric,
  primary key (ticker, market)
);

-- 감시 종목(보유 종목) 상태. 파이프라인이 매 실행마다 횡보·조정 스크리너 기준으로
-- 평가해 최신 상태 1행/종목을 유지한다 (pipeline/src/watchlist.py).
create table if not exists watchlist_status (
  ticker            text not null,
  market            text not null check (market in ('KR', 'US')),
  name              text,
  date              date not null,          -- 마지막 평가일
  qualified         boolean not null,       -- 횡보·조정 탭 진입 조건 통과 여부
  reason            text,                   -- 미통과 사유 (통과 시 null)
  drawdown          numeric,                -- 3년 고점 대비 조정폭 %
  in_drawdown_band  boolean,                -- 조정폭 20~60% 범위
  no_new_low        boolean,                -- 최근 20일 내 신저가 갱신 없음
  box_ok            boolean,                -- 60일 박스폭 30% 이내 (횡보 확인)
  score             numeric,                -- 매수 매력도 0~1 (통과 시)
  days_since_low    int,
  vcp               boolean,
  higher_lows       boolean,
  volume_dry        boolean,
  aligned_mas       boolean,
  volume_trigger    boolean,
  primary key (ticker, market)
);

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
