-- 종목발굴(횡보·조정) 탭에 시총 하한 미달 종목이 남아 있을 때 정리. 1회성.
--
-- 왜 남았나: opportunity_snapshot의 PK가 (ticker, market)이라 날짜가 없다. 파이프라인이
-- 매번 upsert만 하고, 정리는 `computed_at < 오늘` 조건으로 했다. 그런데 시총 하한을 올린
-- 코드가 배포된 날, 그 전에 이미 옛 기준으로 돈 실행이 같은 날짜(computed_at = 오늘)로
-- 행을 써 둔 상태였다. 그래서 새 코드의 정리가 `<` 비교에서 그 행들을 놓쳤다.
--
-- 코드는 고쳤다(db.py의 replace_opportunity_snapshot이 그 시장 행을 지우고 다시 넣는다).
-- 다음 전체 실행부터는 스스로 정리되므로, 이 파일은 그때까지 기다리지 않으려는 경우에만
-- 쓰면 된다.

-- ── 1) 먼저 확인: 하한 미달인데 화면에 뜨는 종목 ────────────────────────
-- opportunity_snapshot에는 시총 컬럼이 없어 stock_universe와 이어 붙여 본다.
-- 하한은 pipeline/src/pipeline.py의 KR_MIN_MARKET_CAP(3,000억) / US_MIN_MARKET_CAP($20억).
select o.market, o.ticker, o.name, u.market_cap, o.computed_at
from opportunity_snapshot o
join stock_universe u on u.ticker = o.ticker and u.market = o.market
where (o.market = 'KR' and u.market_cap < 300000000000)
   or (o.market = 'US' and u.market_cap < 2000000000)
order by o.market, u.market_cap;

-- ── 2) 확인 후 삭제 ─────────────────────────────────────────────────────
-- delete from opportunity_snapshot o
-- using stock_universe u
-- where u.ticker = o.ticker and u.market = o.market
--   and ((o.market = 'KR' and u.market_cap < 300000000000)
--     or (o.market = 'US' and u.market_cap < 2000000000));

-- ── 참고 ────────────────────────────────────────────────────────────────
-- 시총이 stock_universe에 없는 종목은 위 join에서 빠진다. 그런 행이 의심되면:
--   select o.market, o.ticker, o.name, o.computed_at
--   from opportunity_snapshot o
--   left join stock_universe u on u.ticker = o.ticker and u.market = o.market
--   where u.ticker is null;
-- 이 경우는 유니버스에서 사라진 종목(상장폐지 등)이므로 역시 지워도 된다.
