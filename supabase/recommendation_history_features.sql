-- 저점 매집 후보(Gold Standard 패턴) 추천 성적을 "어떤 특성의 후보가 잘 맞았나"로
-- 쪼개기 위한 컬럼 추가. (2026-09-14)
--
-- recommendation_history는 지금까지 ticker·name·sector·entry_price·rank만 남겼다.
-- 그래서 "저점 유지 60일짜리가 20일짜리보다 잘 맞았나", "VCP 충족분이 나았나" 같은
-- 질문에 답할 수 없었다 — 성적은 낼 수 있어도 알고리즘의 어느 조건을 고쳐야 하는지는
-- 알 수 없는 상태였다. 이 컬럼들은 pattern_discovery가 추천 시점에 계산한 원본 수치다.
--
-- 이 파일을 실행하지 않아도 파이프라인은 죽지 않는다 — db.save_recommendation_history가
-- 컬럼 없는 테이블을 감지하면 기본 컬럼만으로 다시 저장하고 로그를 남긴다. 다만 그동안
-- 쌓이는 추천은 특성이 비어서, 성적 화면의 "특성별" 표가 계속 비어 있게 된다.
--
-- 과거 행은 채울 수 없다. pattern_match_results는 매 실행마다 전체 삭제 후 재작성이라
-- 지난 추천의 계산 근거가 어디에도 남아 있지 않다. 따라서 특성별 집계는 이 파일을
-- 실행한 날부터 쌓이기 시작한다 (기존 행은 null → 화면에서 '특성 미기록'으로 빠짐).

alter table recommendation_history
  add column if not exists score            numeric,   -- 복합 점수 0~1 (화면에는 100점 만점으로 환산)
  add column if not exists drawdown_pct     numeric,   -- 52주 최고가 대비 하락률 (%)
  add column if not exists days_since_low   int,       -- 저점 갱신 중단 거래일 수
  add column if not exists vol_ratio        numeric,   -- 최근 20일 ÷ 직전 40일 거래량
  add column if not exists vcp              boolean,   -- ATR10/ATR50 ≤ 0.6 (변동성 수축)
  add column if not exists ma_align         boolean,   -- 종가 > SMA5 > SMA10 > SMA20
  add column if not exists volume_triggered boolean;   -- 대량거래 + 양봉/십자형

-- 확인용
-- select recommended_date, count(*) filter (where days_since_low is not null) as with_features,
--        count(*) as total
--   from recommendation_history group by 1 order by 1 desc limit 10;
