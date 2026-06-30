-- 월봉 OHLCV 집계 RPC
-- PostgREST max_rows=1000 제한을 우회하여 전체 3년치 월봉 데이터를 반환
-- Supabase 대시보드 SQL 에디터에서 실행할 것
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
  with base as (
    select
      s.ticker, s.market, s.date,
      s.open, s.high, s.low, s.close, s.volume,
      date_trunc('month', s.date)::date as month_start,
      row_number() over (
        partition by s.ticker, date_trunc('month', s.date)
        order by s.date asc
      ) as rn_asc,
      row_number() over (
        partition by s.ticker, date_trunc('month', s.date)
        order by s.date desc
      ) as rn_desc
    from stock_price_history s
    where s.market  = p_market
      and s.ticker  = any(p_tickers)
      and s.date   >= p_cutoff
  ),
  monthly as (
    select
      ticker,
      market,
      month_start,
      max(case when rn_asc  = 1 then open  end)::float8 as open,
      max(high)::float8                                  as high,
      min(low)::float8                                   as low,
      max(case when rn_desc = 1 then close end)::float8  as close,
      sum(volume)::bigint                                as volume,
      max(case when rn_desc = 1 then date  end)          as last_date
    from base
    group by ticker, market, month_start
  )
  select ticker, market, last_date as date, open, high, low, close, volume
  from monthly
  order by ticker, month_start
$$;
