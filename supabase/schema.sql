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
  -- 이 행을 쓴 파이프라인 실행 시각. 하루에 여러 번 도는 구조라(아침 전체 06:30 KST +
  -- 저녁 KR 전용 16:30 KST + 수동 재실행) "이 행이 어느 실행에서 나왔는지"를 구분할
  -- 수단이 없으면 사고 시 사후 추적이 불가능하다. db.py가 그날 행을 지우고 다시
  -- 넣으므로(_replace_day) 항상 마지막 실행 시각이 들어간다.
  created_at timestamptz not null default now(),
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
  -- 그 달 "일봉 종가의 최댓값". 3년 고점(get_opp_drawdowns)이 max(high)가 아니라
  -- max(close) 기준이라 필요하다 — 월봉의 close는 마지막 날 종가뿐이라 달 중간의
  -- 고점을 놓치고, high는 장중 고가라 종가 기준보다 높게 나온다.
  -- 10년 시드 구간(우리 일봉이 없던 과거)은 null이며, 3년 창 밖이라 영향이 없다.
  close_high   numeric,
  primary key (ticker, market, month_start)
);
-- 기존 배포에 컬럼 추가 (supabase/monthly_01_backfill.sql이 백필까지 수행):
-- ALTER TABLE stock_long_monthly ADD COLUMN IF NOT EXISTS close_high numeric;

-- 횡보·조정 후보 스냅샷. 이전에는 페이지 요청마다 유니버스 1,460종목의 조정폭을
-- 집계하고, 통과 종목의 일봉 14만 행을 받아 점수를 다시 계산했다(왕복 30회 이상).
-- 데이터는 하루 한 번만 바뀌므로 파이프라인이 미리 계산해 여기 저장하고,
-- 화면은 이 표만 읽는다 (pipeline/src/opportunities.py).
create table if not exists opportunity_snapshot (
  ticker            text not null,
  market            text not null check (market in ('KR', 'US')),
  computed_at       date not null,
  name              text,
  name_kr           text,
  sector            text,
  index_membership  text,
  current_close     numeric,
  high3y            numeric,
  drawdown          numeric,
  score             numeric,
  days_since_low    int,
  vcp               boolean,
  higher_lows       boolean,
  volume_dry        boolean,
  aligned_mas       boolean,
  volume_trigger    boolean,
  as_of_date        date,
  primary key (ticker, market)
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

-- 오늘의 추천(Gold Standard 패턴 매칭) 기록. pattern_match_results가 "지금 화면에
-- 띄울 목록"(매 실행 전체 삭제 후 재작성)인 반면, 이쪽은 "그날 무엇을 추천했는지"를
-- 날짜별로 쌓아 둔다 — 나중에 패턴 추천의 성적을 내려면 진입 시점 기록이 필요하다.
--
-- 주의: 이 테이블은 예전에 Supabase에서 직접 만들어져 schema.sql에 정의만 빠져 있었다.
-- 아래 정의는 pipeline/src/db.py의 save_recommendation_history가 쓰는 컬럼에 맞춘 것이고,
-- `if not exists`라 이미 있는 테이블은 건드리지 않는다(실제 컬럼이 다르면 실제 쪽이 유지됨).
--
-- 현재 읽는 화면은 없다. 파이프라인이 쓰기만 하고 쌓아 두는 상태이며, 하루 몇 행이라
-- 용량 부담은 없다. 성적 집계를 붙일 때 이 기록을 쓰면 된다.
create table if not exists recommendation_history (
  recommended_date  date not null,
  ticker            text not null,
  name              text not null,
  sector            text,
  entry_price       numeric,
  rank              int not null,
  primary key (recommended_date, ticker)
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
  -- 사전 집계된 mv_monthly_ohlcv(최근 600일 구간) + stock_long_monthly(그 이전).
  -- MV는 일봉에서 파생되므로 보관 기간을 줄이면 최근 구간만 남는다. 그 이전을
  -- 영구 테이블에서 채워야 3년 월봉 차트가 잘리지 않는다.
  -- 같은 달이 양쪽에 있으면 MV를 채택한다 — 진행 중인 달은 MV만 매일 갱신된다
  -- (프론트 mergeMonthly와 같은 우선순위).
  with merged as (
    select ticker, market, month_start, last_date as date,
           open, high, low, close, volume, 1 as priority
    from mv_monthly_ohlcv
    where market      = p_market
      and ticker      = any(p_tickers)
      and month_start >= date_trunc('month', p_cutoff)::date

    union all

    select ticker, market, month_start, month_start as date,
           open::float8, high::float8, low::float8, close::float8, volume, 2 as priority
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

-- 3년 고점/현재가/행수를 티커별로 집계 (Supabase 기본 max_rows=1000 우회용 RPC).
-- 일봉은 600일만 보관하므로 그 이전 구간은 월봉(close_high)에서 가져온다.
-- 경계를 일부러 맞추지 않는다 — 겹쳐도 max라 값이 안 변하고, 대신 컷오프가 월
-- 중간에 걸려 그 달이 통째로 빠지는 구멍이 생기지 않는다.
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
  select hi.ticker, hi.high3y::double precision, cur.close::double precision, hi.row_count
  from hi
  join cur using (ticker)
$$;

-- 방금 끝난 달의 월봉을 stock_long_monthly에 적립 (파이프라인이 매 실행 끝에 호출).
-- 일봉이 600일 밖으로 밀려나기 전에 월봉으로 남겨두지 않으면 3년 고점이 무너진다.
create or replace function accrue_long_monthly()
returns void
language sql
as $$
  insert into stock_long_monthly
    (ticker, market, month_start, open, high, low, close, volume, close_high)
  select
    ticker, market, date_trunc('month', date)::date,
    (array_agg(open  order by date asc ))[1],
    max(high), min(low),
    (array_agg(close order by date desc))[1],
    sum(volume), max(close)
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
