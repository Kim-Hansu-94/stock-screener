-- [1/5] 월봉 영구 보존 준비 + 과거 구간 백필
--
-- 왜: 일봉(stock_price_history)을 600일로 줄이려는데, 월봉을 담은
--     mv_monthly_ohlcv는 그 일봉에서 파생되는 뷰라 일봉을 지우면 과거 월봉까지
--     같이 증발한다. 그래서 지우기 전에 stock_long_monthly(영구 테이블)로 옮겨둔다.
--
-- ⚠️ 이 파일은 일봉이 아직 3년치 있을 때 돌려야 의미가 있다. 5/5(정리)를 먼저
--    돌리면 옮길 데이터가 이미 없다.
--
-- 소요: 일봉 약 160만 행을 한 번 훑는다. 1~2분 예상.

-- ── close_high: 그 달 "일봉 종가의 최댓값" ────────────────────────────────
-- 3년 고점(get_opp_drawdowns)은 max(high)가 아니라 max(close) 기준이다.
-- 월봉의 close는 그 달 마지막 날 종가뿐이라 달 중간의 고점을 놓치고,
-- high는 장중 고가라 종가 기준보다 높게 나온다. 둘 다 원래 값과 어긋나므로
-- "그 달 일봉 종가의 최댓값"을 따로 저장해야 값이 정확히 보존된다.
alter table stock_long_monthly add column if not exists close_high numeric;

-- ── 백필 ──────────────────────────────────────────────────────────────
-- mv_monthly_ohlcv가 아니라 일봉에서 직접 집계한다(MV에는 close_high가 없음).
-- 진행 중인 이번 달은 아직 확정이 아니므로 제외한다.
insert into stock_long_monthly
  (ticker, market, month_start, open, high, low, close, volume, close_high)
select
  ticker,
  market,
  date_trunc('month', date)::date as month_start,
  (array_agg(open  order by date asc ))[1] as open,
  max(high)                                as high,
  min(low)                                 as low,
  (array_agg(close order by date desc))[1] as close,
  sum(volume)                              as volume,
  max(close)                               as close_high
from stock_price_history
where date < date_trunc('month', current_date)::date
group by ticker, market, date_trunc('month', date)
on conflict (ticker, market, month_start) do update set
  -- 기존 10년 시드본보다 우리가 직접 모은 일봉 집계가 정확하므로 덮어쓴다.
  open       = excluded.open,
  high       = excluded.high,
  low        = excluded.low,
  close      = excluded.close,
  volume     = excluded.volume,
  close_high = excluded.close_high;

-- ── 확인 ──────────────────────────────────────────────────────────────
-- close_high가 채워진 월이 3년치(약 36개월) 있어야 한다.
select
  count(*)                                   as total_rows,
  count(close_high)                          as rows_with_close_high,
  min(month_start) filter (where close_high is not null) as close_high_from,
  max(month_start)                           as newest_month
from stock_long_monthly;
