-- Supabase SQL 에디터에서 1회 실행.
--
-- 배경: screened_stocks에 "이 행이 어느 실행에서 나왔는지"를 나타내는 컬럼이 없었다.
-- 파이프라인은 하루에 두 번 이상 돈다(아침 전체 06:30 KST · 저녁 KR 전용 16:30 KST ·
-- 필요 시 수동 재실행). 예전 코드가 upsert만 하던 시절에는 이번 실행에서 빠진 종목의
-- 지난 실행 행이 그대로 남아 유령처럼 화면에 떴는데, 실행 시각이 없어 어느 행이
-- 유령인지 사후에 가려낼 방법이 아예 없었다.
--
-- 쓰기 로직은 db.py의 _replace_day가 그날·그 시장 행을 지우고 다시 넣도록 바뀌어
-- 유령 자체가 더는 생기지 않는다. 이 컬럼은 그 다음 단계의 안전장치다 —
-- 앞으로 비슷한 일이 생기면 "언제 쓰인 행인지"로 즉시 판별할 수 있다.

alter table screened_stocks
  add column if not exists created_at timestamptz not null default now();

-- 기존 행은 실제 실행 시각을 알 수 없으므로 now()로 채워진다. 즉 이 마이그레이션
-- 이전 행끼리는 여전히 서로 구분되지 않는다(값이 전부 같아진다). 구분이 유효해지는
-- 것은 이 시점 이후에 쓰인 행부터다.

-- 참고 조회: 날짜별로 언제 쓰인 행들인지 확인
--   select date, market, count(*), min(created_at), max(created_at)
--   from screened_stocks group by date, market order by date desc limit 30;
