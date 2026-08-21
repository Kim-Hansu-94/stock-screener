-- [3/5] RPC를 "일봉 ∪ 월봉" 기준으로 재작성
--
-- 2/5 대조 검증이 0행으로 끝난 뒤에 실행할 것. 아직 일봉이 3년치 있어도
-- 결과는 동일하므로(겹치는 구간은 max로 흡수) 이 시점에 배포해도 안전하다.
-- 즉 5/5(삭제)를 나중에 돌려도 그 사이 화면 값이 변하지 않는다.

-- ── 3년 고점 ─────────────────────────────────────────────────────────
-- 예전: 일봉 3년치의 max(close).
-- 지금: 남아 있는 일봉 ∪ 확정 월봉(close_high)의 max.
--
-- 경계를 일부러 맞추지 않는다. 겹쳐도 max라 값이 안 변하고, 대신 컷오프가 월
-- 중간에 걸려 그 달이 통째로 빠지는 구멍이 생기지 않는다. 창 시작점은 "3년 전이
-- 속한 달의 1일"이라 최대 30일 길어질 수 있는데, 고점을 잃는 것보다 낫다.
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
  with candidates as (
    select h.ticker, h.close as px
    from stock_price_history h
    where h.market  = p_market
      and h.ticker  = any(p_tickers)
      and h.date   >= p_cutoff

    union all

    select m.ticker, coalesce(m.close_high, m.close) as px
    from stock_long_monthly m
    where m.market       = p_market
      and m.ticker       = any(p_tickers)
      and m.month_start >= date_trunc('month', p_cutoff)::date
      and m.month_start <  date_trunc('month', current_date)::date
  ),
  hi as (
    select ticker, max(px) as high3y, count(*) as row_count
    from candidates
    group by ticker
  ),
  -- 현재가는 계속 일봉에서 — 최신 종가는 항상 보관 구간 안에 있다.
  cur as (
    select distinct on (h.ticker) h.ticker, h.close
    from stock_price_history h
    where h.market = p_market
      and h.ticker = any(p_tickers)
    order by h.ticker, h.date desc
  )
  select
    hi.ticker,
    hi.high3y::double precision,
    cur.close::double precision,
    hi.row_count
  from hi
  join cur using (ticker)
$$;

-- ── 월봉 조회 ────────────────────────────────────────────────────────
-- mv_monthly_ohlcv는 일봉에서 파생되므로 보관 기간을 줄이면 최근 구간만 남는다.
-- 그 이전은 stock_long_monthly에서 채워 넣어야 오늘의 추천(3년 월봉 차트)이
-- 잘리지 않는다. 같은 달이 양쪽에 있으면 MV를 채택한다 — 진행 중인 달은 MV만
-- 매일 갱신되기 때문이다(프론트 mergeMonthly와 같은 우선순위).
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
  with merged as (
    select
      ticker, market, month_start, last_date as date,
      open, high, low, close, volume,
      1 as priority
    from mv_monthly_ohlcv
    where market      = p_market
      and ticker      = any(p_tickers)
      and month_start >= date_trunc('month', p_cutoff)::date

    union all

    select
      ticker, market, month_start, month_start as date,
      open::float8, high::float8, low::float8, close::float8, volume,
      2 as priority
    from stock_long_monthly
    where market      = p_market
      and ticker      = any(p_tickers)
      and month_start >= date_trunc('month', p_cutoff)::date
  )
  select distinct on (ticker, month_start)
    ticker, market, date, open, high, low, close, volume
  from merged
  order by ticker, month_start, priority
$$;

-- ── 월봉 적립 ────────────────────────────────────────────────────────
-- 파이프라인이 매 실행 끝에 부른다. 방금 끝난 달을 일봉에서 집계해
-- stock_long_monthly에 넣어둔다 — 그래야 나중에 그 일봉이 삭제돼도 남는다.
-- 최근 2개월만 훑는다(월말 직후 실행·재실행 대비 여유). 전체 백필은 1/5이 한다.
create or replace function accrue_long_monthly()
returns void
language sql
as $$
  insert into stock_long_monthly
    (ticker, market, month_start, open, high, low, close, volume, close_high)
  select
    ticker,
    market,
    date_trunc('month', date)::date,
    (array_agg(open  order by date asc ))[1],
    max(high),
    min(low),
    (array_agg(close order by date desc))[1],
    sum(volume),
    max(close)
  from stock_price_history
  where date >= date_trunc('month', current_date - interval '2 months')::date
    and date <  date_trunc('month', current_date)::date
  group by ticker, market, date_trunc('month', date)
  on conflict (ticker, market, month_start) do update set
    open       = excluded.open,
    high       = excluded.high,
    low        = excluded.low,
    close      = excluded.close,
    volume     = excluded.volume,
    close_high = excluded.close_high;
$$;
