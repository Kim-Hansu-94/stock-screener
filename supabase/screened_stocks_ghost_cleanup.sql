-- 지난 실행에서 남은 "유령 행" 진단 및 정리. Supabase SQL 에디터에서 실행.
--
-- 유령 행이란: 예전 db.py는 screened_stocks를 upsert만 했다. PK가
-- (date, market, ticker)라 같은 종목은 덮이지만, 이번 실행에서 조건을 만족하지 않아
-- 빠진 종목의 지난 실행 행은 그대로 남았다. 파이프라인은 하루에 두 번 이상 돌기
-- 때문에(아침 전체 06:30 KST · 저녁 KR 전용 16:30 KST · 수동 재실행) 그 사이
-- 기준이나 코드가 바뀌면 옛 기준으로 뽑힌 종목이 화면에 계속 떴다.
--
-- 쓰기 로직은 이미 고쳐졌다(_replace_day가 그날 행을 지우고 다시 넣는다).
-- 이 파일은 그 전에 이미 쌓인 행을 다루기 위한 것이다.
--
-- ⚠ 한계: 대부분의 유령 행은 사후 식별이 불가능하다. 실행 시각 컬럼이 없었기 때문에
-- "같은 날짜의 두 행 중 어느 쪽이 옛 실행 것인지" 구분할 근거가 데이터에 없다.
-- 아래 2)에서 지울 수 있는 건 '현재 기준으로는 절대 나올 수 없는 행'뿐이다.


-- ── 1) 진단: 날짜별 행 수 ──────────────────────────────────────────────
-- 평소보다 눈에 띄게 많은 날이 여러 번 실행되며 누적된 날이다.
select date, market, count(*) as rows,
       count(*) filter (where passed) as passed_rows
from screened_stocks
group by date, market
order by date desc, market;


-- ── 2) 확실하게 식별 가능한 유령: 시총 하한 미만 ──────────────────────
-- pipeline.py는 시총 하한을 후보 선정 단계의 하드 필터로 쓴다
-- (KR_MIN_MARKET_CAP 3,000억 / US_MIN_MARKET_CAP $20억, candidates = ... &
--  meets_cap_threshold). 즉 통과 종목이든 근접 후보든 하한 미만 행은 현재 코드에서
-- 나올 수 없다. 테이블에 남아 있다면 하한을 올리기 전 실행이 남긴 행이다.

-- 먼저 규모 확인 (지우지 않고 세기만)
select market, count(*) as ghost_rows, min(date) as oldest, max(date) as newest
from screened_stocks
where (market = 'KR' and market_cap < 300000000000)
   or (market = 'US' and market_cap < 2000000000)
group by market;

-- 확인 후 실제 삭제 (위 결과가 납득되면 실행)
-- delete from screened_stocks
-- where (market = 'KR' and market_cap < 300000000000)
--    or (market = 'US' and market_cap < 2000000000);


-- ── 3) 참고: 남는 유령에 대해 ─────────────────────────────────────────
-- 2)로 걸러지지 않는 유령(시총은 충분한데 다른 조건이 어긋난 행)은 남는다.
-- 이론상 stock_price_history의 3년치 일봉으로 과거 날짜를 재계산해 대조할 수 있지만,
-- 그 사이 스크리닝 기준 자체가 여러 번 바뀌었기 때문에 재계산 결과와 다르다는 것이
-- "유령"을 뜻하지 않는다 — 당시 기준으로는 정당하게 뽑힌 행일 수 있다. 이 둘을
-- 데이터만으로 구분할 수 없으므로 일괄 재계산 삭제는 하지 않는다.
--
-- 실질적 영향은 성적표(history) 집계가 그만큼 부풀려지는 것이고, 새로 쌓이는 날짜에는
-- 더 이상 발생하지 않는다. created_at 컬럼(screened_stocks_created_at.sql)을 넣어
-- 두면 앞으로는 같은 상황이 생겨도 즉시 판별할 수 있다.
