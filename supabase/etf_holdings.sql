-- 490590 구성종목·비중 (pipeline/src/etf_holdings.py)
--
-- 왜 표로 두는가: 예전엔 frontend/lib/etfEntryCheck.ts에 종목·비중을 손으로 적어
-- 뒀는데, 지수가 리밸런싱되면 아무도 모르고 화면이 조용히 틀린 바구니로 신호등을
-- 계산했다(2026-09-25에 10개 중 5개가 어긋나 있었다).
--
-- Supabase 대시보드 SQL 에디터에서 한 번 실행할 것.
create table if not exists etf_holdings (
  etf_ticker   text not null,
  -- 네이버가 주는 순위(상위 10개). 티커를 못 이은 행도 남기므로 PK는 seq로 잡는다.
  seq          integer not null,
  -- 이름을 티커로 못 이으면 null. **행을 버리지 않는다** — 조용히 사라지면
  -- "구성에 없다"와 "이름을 못 이었다"가 구분되지 않는다(파이프라인이 경고를 띄운다).
  ticker       text,
  name         text not null,
  stock_count  integer not null,
  -- 주식 수 x 종가를 **이은 종목끼리** 100%로 정규화한 상대 비중.
  -- 네이버가 상위 10개만 주므로 ETF 전체에서 몇 %인지는 알 수 없다. 화면이 쓰는
  -- 것도 판정 대상끼리의 상대 비중이라 이걸로 충분하다. 일봉이 없으면 null.
  weight_pct   numeric,
  -- 네이버가 밝힌 기준일. 화면이 "언제 기준인지"를 같이 보여준다.
  as_of        text not null,
  updated_at   text not null,
  primary key (etf_ticker, seq)
);

create index if not exists etf_holdings_etf_idx on etf_holdings (etf_ticker, seq);
