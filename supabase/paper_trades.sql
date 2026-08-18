-- 가상 매매장. Supabase SQL 에디터에서 1회 실행.
--
-- 지금까지 성적표는 "추천된 종목을 전부 샀다면"을 가정해 계산했다. 실제로는 그중
-- 일부만 사고, 사는 시점도 다르다. 이 테이블은 사이트에서 직접 누른 매수/매도만
-- 기록해 "내가 실제로 한 매매"의 성적을 따로 낸다.
--
-- 진입가는 매수 버튼을 누른 시점의 '직전 종가'다. 사이트가 가진 가격이 일봉뿐이라
-- 장중 체결가는 알 수 없다. 이 한계는 화면에도 표시한다.

create table if not exists paper_trades (
  id uuid primary key default gen_random_uuid(),
  market text not null check (market in ('KR', 'US')),
  ticker text not null,
  name text not null,
  sector text not null default '',
  -- 어느 화면에서 눌렀는지 (눌림목 스크리닝 / 횡보·조정). 나중에 "어느 탭이 잘 맞나"를
  -- 가르는 데 쓴다.
  source text not null default 'pullback' check (source in ('pullback', 'opportunity')),

  entry_date date not null,
  entry_price numeric not null check (entry_price > 0),

  -- 매도 전에는 null. 이 두 값이 채워지면 청산된 트레이드다.
  exit_date date,
  exit_price numeric check (exit_price > 0),

  created_at timestamptz not null default now(),
  closed_at timestamptz,

  -- 매도 기록은 둘 다 있거나 둘 다 없어야 한다 (한쪽만 채워진 반쪽 상태 방지)
  constraint paper_trades_exit_pair check (
    (exit_date is null and exit_price is null) or
    (exit_date is not null and exit_price is not null)
  )
);

-- 같은 종목을 열린 채로 두 번 사지 못하게 한다. 실수로 매수를 두 번 눌렀을 때
-- 유령 포지션이 생기는 걸 DB 차원에서 막는다. (판 뒤에는 다시 살 수 있다.)
create unique index if not exists idx_paper_trades_open_unique
  on paper_trades (market, ticker)
  where exit_date is null;

create index if not exists idx_paper_trades_open
  on paper_trades (exit_date, market);
