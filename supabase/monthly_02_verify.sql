-- [2/5] 대조 검증 — 월봉 기반 3년 고점이 지금 값과 정확히 같은지 확인
--
-- 이게 어긋나면 조정폭(20~60% 밴드)이 흔들려 종목발굴 탭에 뜨는 종목이 바뀐다.
-- 그래서 일봉을 지우기 전에 "지금 방식"과 "앞으로 방식"을 같은 데이터로 나란히
-- 계산해 대조한다. 아직 일봉이 3년치 있어야 비교가 가능하다.
--
-- 앞으로 방식 = 남아 있는 일봉 ∪ 확정된 월봉 전체(close_high).
--   경계를 600일에 맞추지 않고 "완료된 달 전부"를 그냥 합친다. 겹치는 구간이
--   생기지만 max()라 결과가 바뀌지 않고, 대신 컷오프가 월 중간에 걸려 그 달이
--   통째로 빠지는 구멍이 원천적으로 없다.
--
-- 창 시작점은 양쪽 모두 "3년 전이 속한 달의 1일"로 맞춘다. 월봉은 달 단위라
-- 3년 전 날짜에서 정확히 자를 수 없어, 그 달을 통째로 포함하는 쪽을 택했다
-- (고점을 잃는 것보다 창이 최대 30일 길어지는 편이 안전하다).
--
-- 기대 결과: 0행. 행이 나오면 그 종목만 따로 볼 것(백필 누락·티커 변경 등).

with params as (
  select
    date_trunc('month', current_date - 1095)::date as window_start,
    date_trunc('month', current_date)::date        as this_month,
    (current_date - 600)::date                     as retain_from
),
-- 지금 방식: 일봉 종가의 최댓값
old_way as (
  select h.ticker, h.market, max(h.close) as high3y
  from stock_price_history h, params p
  where h.date >= p.window_start
  group by h.ticker, h.market
),
-- 앞으로 방식: 삭제 이후를 시뮬레이션한다 — 일봉은 600일까지만 있다고 치고,
-- 그 이전 구간을 월봉(close_high)이 제대로 보존하고 있는지를 본다.
-- (여기에 3년 일봉을 그대로 넣으면 월봉이 비어 있어도 통과해버려 시험이 안 된다)
new_way as (
  select ticker, market, max(px) as high3y
  from (
    select h.ticker, h.market, h.close as px
    from stock_price_history h, params p
    where h.date >= p.retain_from

    union all

    select m.ticker, m.market, coalesce(m.close_high, m.close) as px
    from stock_long_monthly m, params p
    where m.month_start >= p.window_start
      and m.month_start <  p.this_month
  ) merged
  group by ticker, market
)
select
  o.market,
  o.ticker,
  o.high3y as old_high3y,
  n.high3y as new_high3y,
  round(abs(o.high3y - n.high3y) / nullif(o.high3y, 0) * 100, 4) as diff_pct
from old_way o
join new_way n using (ticker, market)
where abs(o.high3y - n.high3y) / nullif(o.high3y, 0) > 0.0001
order by diff_pct desc
limit 50;
