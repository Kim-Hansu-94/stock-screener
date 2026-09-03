-- 사용자가 사이트에서 직접 추가하는 감시 종목. Supabase SQL 에디터에서 1회 실행.
--
-- 예전에는 pipeline/src/watchlist.py의 WATCHLIST 상수(코드)에 종목을 한 줄씩
-- 추가해야 했다 — 뉴스·소문으로 관심 가는 종목을 그때그때 추가하고 싶은데 코드를
-- 고치고 배포해야 하니 사실상 못 쓰는 기능이었다. 이 테이블은 그 종목 목록을
-- 코드 밖으로 꺼내, 홈 화면 "감시 종목" 카드에서 티커만 입력하면 바로 추가되게
-- 한다. WATCHLIST 상수는 기본값으로 남아 있고, watchlist.py가 매 실행마다
-- 이 테이블과 합쳐서 평가한다.

create table if not exists watchlist_tickers (
  market   text not null check (market in ('KR', 'US')),
  ticker   text not null,
  name     text not null,
  added_at timestamptz not null default now(),
  primary key (market, ticker)
);

-- paper_trades와 동일한 이유로 RLS를 켜고 정책은 만들지 않는다 — anon 키로는
-- 접근 불가, 프론트 API 라우트(/api/watchlist)는 service key로 붙어 PIN 검사를
-- 통과한 요청만 이 테이블을 쓴다.
alter table watchlist_tickers enable row level security;

-- ── 선택: 초기 관심 종목 시드 ──────────────────────────────────────────
-- 위 CREATE TABLE만 실행해도 되고, 아래는 처음부터 채워두고 싶을 때만 같이 실행한다.
-- 사이트에서 "관심 종목 추가" 폼으로 한 종목씩 넣는 것과 결과는 동일하다(직접
-- 추가한 것과 구분 없이 똑같이 평가·표시된다) — 여기 넣어두면 한 번에 넣을 수 있어
-- 편할 뿐이다. stock_price_history에 해당 종목 시세가 아직 없으면(신규 상장 등)
-- 다음 파이프라인 실행에서도 평가되지 않으니, 그런 경우엔 시세가 쌓인 뒤 다시 시도.
insert into watchlist_tickers (market, ticker, name) values
  ('US', 'TEM',  '템퍼스AI'),
  ('US', 'ENVX', '에노빅스'),
  ('US', 'FAC',  '팩토리얼 에너지'),
  ('US', 'GLUE', '몬테로사 테라퓨틱스'),
  ('US', 'BZAI', '블레이즈 홀딩스'),
  ('US', 'SLDP', '솔리드파워'),
  ('US', 'IONQ', '아이온큐'),
  ('US', 'ARQQ', '아킷 퀀텀'),
  ('US', 'CRWV', '코어위브'),
  ('US', 'QNT',  '퀀티넘'),
  ('US', 'ACHR', '아처 에비에이션'),
  ('US', 'RCAT', '레드캣 홀딩스'),
  ('US', 'UMAC', '언유주얼 머신스'),
  ('US', 'AVAV', '에어로바이런먼트'),
  ('US', 'JOBY', '조비 에비에이션'),
  ('US', 'CLFD', '클리어필드'),
  ('US', 'AEVA', '에바 테크놀로지스'),
  ('US', 'OKLO', '오클로')
on conflict (market, ticker) do nothing;
