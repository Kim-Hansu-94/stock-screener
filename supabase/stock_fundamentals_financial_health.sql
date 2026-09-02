-- Supabase SQL 에디터에서 1회 실행.
--
-- 배경: 종목발굴 화면(횡보·조정)에 지금까지 매출·이익 기반 실적 판정("가치함정 /
-- 밸류에이션조정")만 있었는데, 재무건전성(단기 지급능력)은 전혀 안 보고 있었다.
-- 한눈에 보는 실전 재무제표가 다루는 유동비율(유동자산÷유동부채, 2.0 이상 양호)과
-- 부채비율(부채총계÷자본총계)을 추가한다.
--
-- KR(DART)이 이미 부르고 있는 fnlttSinglAcnt.json 응답에 대차대조표 주요계정도
-- 같이 들어 있어서 추가 API 호출 없이 채울 수 있다. US(yfinance)는 대차대조표
-- 조회가 손익계산서와 별도 호출이라 이번엔 KR만 채운다 — 아래 4개 컬럼은 US 행에서는
-- 당분간 계속 null이다.

alter table stock_fundamentals
  add column if not exists current_assets      numeric,
  add column if not exists current_liabilities numeric,
  add column if not exists total_liabilities    numeric,
  add column if not exists total_equity         numeric;

-- 기존 행(마이그레이션 이전에 저장된 것)은 이 4개 컬럼이 null로 남는다. KR 종목은
-- fundamentals.py의 MAX_AGE_DAYS(30일) 갱신 주기를 타고 다음 실행부터 자연스럽게
-- 채워진다 — 별도 백필 불필요.
