-- [5/5] 자동 정리 잡을 600일 기준으로 교체
--
-- 지금도 3년 기준 정리 잡이 돌고 있다(가장 오래된 일봉이 3년 전후인 것으로 확인).
-- 4/5에서 보관 기준을 600일로 줄였으므로 잡도 같이 바꿔야 한다 — 안 그러면
-- 다음 실행 때 다시 3년치가 쌓이기 시작한다.

-- ── ① 지금 걸려 있는 잡 확인 ─────────────────────────────────────────
-- jobname과 command를 보고, stock_price_history를 지우는 잡의 이름을 찾는다.
select jobid, jobname, schedule, command
from cron.job
order by jobid;

-- ── ② 기존 잡 해제 ──────────────────────────────────────────────────
-- 위에서 찾은 이름으로 바꿔서 실행할 것.
-- select cron.unschedule('여기에_기존_잡_이름');

-- ── ③ 새 잡 등록 ────────────────────────────────────────────────────
-- 매주 일요일 18:00 UTC (월요일 03:00 KST) — 장이 열리지 않는 시간대.
-- 삭제만 하고 VACUUM FULL은 걸지 않는다. 주간 삭제량은 얼마 안 되고,
-- VACUUM FULL은 테이블을 통째로 잠가서 파이프라인과 부딪히면 그날 실행이 죽는다.
-- 평소 회수는 autovacuum이 맡는다.
select cron.schedule(
  'trim-stock-price-history',
  '0 18 * * 0',
  $$delete from stock_price_history where date < (current_date - 600)::date$$
);

-- ── ④ 등록 확인 ─────────────────────────────────────────────────────
select jobid, jobname, schedule, active
from cron.job
where jobname = 'trim-stock-price-history';
