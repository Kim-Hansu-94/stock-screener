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

create table if not exists stock_universe (
  ticker            text not null,
  market            text not null check (market in ('KR', 'US')),
  name              text,
  sector            text,
  index_membership  text,
  updated_at        text not null,
  primary key (ticker, market)
);

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
