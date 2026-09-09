-- AI 전력 인프라 12종목을 감시 목록에 추가. Supabase SQL 에디터에서 1회 실행.
--
-- 2026-09-09. 파이프라인 실행 로그를 보니 기존 감시 종목 23개가 전부 "대기"
-- (매집 구간 미진입)였고, 그 목록은 오클로·코어위브·아이온큐처럼 60일 박스폭이
-- 100%를 넘나드는 고변동 종목에 몰려 있었다. 대조군으로 "이미 매출·이익이 나오는"
-- 전력 인프라 쪽을 같은 잣대로 매일 판정받아 보려고 추가한다.
--
-- 전부 아직 안 산 종목이라 category는 기본값 'accumulation'(매집 감시)으로 둔다.
-- 나중에 실제로 매수하면 사이트에서 삭제하고 "보유 종목 추가"로 다시 넣으면
-- 'position'(포지션 관리)으로 잡힌다.
--
-- 이 파일로 넣은 행은 사이트에서 직접 추가한 것과 완전히 동일하다 — 감시 종목
-- 카드에서 그냥 삭제할 수 있다. (pipeline/src/watchlist.py의 WATCHLIST 상수에
-- 박으면 사이트에서 못 지우므로 그쪽은 쓰지 않는다.)
--
-- 실행 전에 frontend/app/api/watchlist/route.ts의 MAX_WATCHLIST_SIZE가 40으로
-- 올라간 커밋이 배포돼 있어야 한다. 이 INSERT 자체는 상한을 안 타지만(상한은
-- API 라우트에만 있다), 30인 채로 두면 23 + 12 = 35가 되어 사이트에서 종목을
-- 하나도 더 못 넣는 상태가 된다.
--
-- 국내 4종목의 종목코드는 외부 기업정보(FnGuide 등)에서 확인한 값이다.
-- 대한광통신(010170)은 코스닥이지만, 감시 종목은 정규 스크리닝 유니버스
-- (KOSPI 시총 3,000억 이상) 밖의 임의 종목도 되므로 상관없다.
--
-- 추가 직후에는 아직 평가 결과(watchlist_status)가 없어 화면에 "평가 대기"로
-- 뜬다. 다음 파이프라인 실행에서 _backfill_missing_watchlist_history()가 3년치
-- 일봉을 받아온 뒤부터 조정폭·박스폭 판정이 나온다.

insert into watchlist_tickers (market, ticker, name, category) values
  -- 국내: 전력 기자재·발전 설비
  ('KR', '000500', '가온전선',           'accumulation'),
  ('KR', '034020', '두산에너빌리티',     'accumulation'),
  ('KR', '336260', '두산퓨얼셀',         'accumulation'),
  ('KR', '010170', '대한광통신',         'accumulation'),
  -- 미국: 발전 사업자·설비
  ('US', 'GEV',    'GE 버노바',          'accumulation'),
  ('US', 'VST',    '비스트라 에너지',     'accumulation'),
  ('US', 'CEG',    '컨스털레이션 에너지', 'accumulation'),
  ('US', 'NEE',    '넥스트에라 에너지',   'accumulation'),
  ('US', 'SMR',    '뉴스케일 파워',       'accumulation'),
  ('US', 'BE',     '블룸 에너지',         'accumulation'),
  -- 미국: AI 데이터센터 부품·소프트웨어
  ('US', 'LITE',   '루멘텀 홀딩스',       'accumulation'),
  ('US', 'CRM',    '세일즈포스',          'accumulation')
on conflict (market, ticker) do nothing;

-- 확인용: 지금 감시 목록이 몇 개인지 (상한 40)
select count(*) as 감시종목수 from watchlist_tickers;
