-- Run this once in the Supabase SQL editor.
--
-- 월봉 사전 집계로 /discover 미래먹거리 화면의 콜드 렌더 병목(get_monthly_ohlcv가
-- 매 호출마다 일봉을 윈도우 함수로 접던 ~6.7초)을 리프레시 시점 1회로 옮긴다.
-- 이후 조회는 단순 인덱스 스캔이라 1초 미만으로 떨어진다.
--
-- CREATE MATERIALIZED VIEW는 생성 즉시 전체 히스토리를 1회 집계하므로 수 초 걸릴 수
-- 있다(정상). 이후 갱신은 파이프라인이 refresh_monthly_ohlcv() RPC로 처리한다.

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

-- REFRESH ... CONCURRENTLY는 유니크 인덱스가 필수.
create unique index if not exists idx_mv_monthly_pk
  on mv_monthly_ohlcv (ticker, market, month_start);
create index if not exists idx_mv_monthly_lookup
  on mv_monthly_ohlcv (market, ticker, last_date);

-- 파이프라인에서 RPC로 호출하는 갱신 함수.
create or replace function refresh_monthly_ohlcv()
returns void
language plpgsql
as $$
begin
  refresh materialized view concurrently mv_monthly_ohlcv;
end;
$$;

-- get_monthly_ohlcv를 MV 조회로 교체 (시그니처 동일 → 프론트엔드 무수정).
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
  select ticker, market, last_date as date, open, high, low, close, volume
  from mv_monthly_ohlcv
  where market  = p_market
    and ticker  = any(p_tickers)
    and last_date >= p_cutoff
  order by ticker, month_start
$$;
