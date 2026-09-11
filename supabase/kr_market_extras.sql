-- 국내 시장 부가 데이터 3종 (수급 · 목표주가 컨센서스 · 자사주 매입).
--
-- 주식 본 파이프라인과 분리된 별도 워크플로(.github/workflows/kr_market_extras.yml)가
-- 채운다 — 부동산과 같은 이유다. 여기가 실패했다고 매일 도는 스크리닝이 죽으면 안 되고,
-- 갱신 주기도 다르다(수급은 매일, 컨센서스·자사주는 며칠에 한 번이면 충분).
--
-- schema.sql이 아니라 별도 파일인 것도 realestate.sql·paper_trades.sql과 같은 규칙이다:
-- 본 파이프라인이 없어도 되는 테이블은 따로 둬서, schema.sql을 다시 돌릴 일과 분리한다.

-- 수급: 일별 외국인·기관 순매매.
-- 종목 × 날짜로 쌓이는 표라 PK가 (market, ticker, date)다. 파이프라인이 매 실행
-- 최근 60일을 통째로 다시 받아 upsert하므로, 뒤늦게 정정된 값도 자동으로 따라온다.
create table if not exists investor_flow (
  market      text not null check (market in ('KR', 'US')),
  ticker      text not null,
  name        text,
  date        date not null,
  close       numeric not null,
  -- 순매매 "수량(주)". 네이버가 주는 원본 단위 그대로다.
  foreign_net_qty       numeric,
  institution_net_qty   numeric,
  -- 위 수량 × 종가. 장중 평균단가가 아니라 근사치이며, 화면에서 "몇 억 규모인가"를
  -- 가늠하는 용도다. 종가만으로 재현되므로 나중에 검증하기 쉽다.
  foreign_net_amount     numeric,
  institution_net_amount numeric,
  source      text,
  updated_at  timestamptz not null default now(),
  primary key (market, ticker, date)
);

create index if not exists investor_flow_ticker_date_idx
  on investor_flow (market, ticker, date desc);

-- 목표주가 컨센서스: 증권사 평균 목표가.
-- 종목당 최신 1행만 유지하는 스냅샷이다(market_index_snapshot과 같은 성격) —
-- 목표가 시계열은 아직 화면에서 안 쓰고, 쌓으면 용량만 는다(무료 플랜 500MB).
create table if not exists stock_consensus (
  market        text not null check (market in ('KR', 'US')),
  ticker        text not null,
  name          text,
  date          date not null,
  target_price  numeric not null,
  -- 저장 시점 종가 대비 상승여력(%). 화면이 최신 종가로 다시 계산할 수도 있어
  -- 참고값이다 — 이 값이 언제 기준인지는 date 열이 말해 준다.
  upside_pct    numeric,
  opinion       text,
  report_count  int,
  consensus_eps numeric,
  source        text,
  updated_at    timestamptz not null default now(),
  primary key (market, ticker)
);

-- 자사주 매입: 진행 중인(또는 가장 최근) 자기주식 취득 프로그램.
-- 이것도 종목당 최신 1행 스냅샷이다.
--
-- 진행률이 두 개인 것이 의도적이다. amount_progress_pct는 취득 "금액" 기준의 진짜
-- 진행률이고, period_progress_pct는 금액을 모를 때 쓰는 "기간" 기준 근사치다.
-- 하나로 합치면 화면에서 어느 근거인지 알 수 없게 되므로 나눠 둔다.
create table if not exists stock_buyback (
  market      text not null check (market in ('KR', 'US')),
  ticker      text not null,
  name        text,
  corp_code   text,
  latest_report       text,
  latest_report_date  date,
  latest_report_url   text,
  -- 처분(파는 것)은 매입과 방향이 정반대다. 같은 표에 담되 화면에서 구분한다.
  is_disposal         boolean not null default false,
  planned_amount      numeric,
  planned_qty         numeric,
  acquired_amount     numeric,
  amount_progress_pct numeric,
  period_progress_pct numeric,
  period_start        date,
  period_end          date,
  disclosure_count    int,
  detail_source       text,
  -- 상세 API가 전부 실패했을 때의 사유. 채워져 있으면 "공시 목록만 받았다"는 뜻이라,
  -- 조용히 반쪽짜리로 도는 상태를 로그가 아니라 DB에서도 알아볼 수 있다.
  detail_error        text,
  updated_at  timestamptz not null default now(),
  primary key (market, ticker)
);

-- 2026-09-10 추가: 취득 예정 "수량". DART 주요사항보고서가 금액과 함께 주는데,
-- 처음 표를 만들 때 필드명을 확정하지 못해 빠져 있었다. 이미 표를 만든 뒤라면
-- 아래 한 줄만 따로 실행하면 된다(이미 있으면 아무 일도 일어나지 않는다).
alter table stock_buyback add column if not exists planned_qty numeric;

-- ============================================================
-- 2026-09-10 추가: 거래원(증권사 창구별 매매) — 자사주 매입 진행 중 추적용
-- ============================================================
--
-- 자기주식 취득 결정 공시에는 **위탁투자중개업자**(어느 증권사 창구로 살지)가 적혀
-- 있다(`stock_buyback.broker`). 거래소가 매일 공개하는 종목별 상위 매수·매도 창구에서
-- 그 증권사의 순매수를 누적하면, 결과보고서가 나오기 전에도 매입량을 추정할 수 있다.
--
-- **추정치다.** 그 창구 매수가 전부 자사주는 아니다(같은 증권사 일반 고객 주문이 섞임).
-- 화면은 이걸 확정 진행률과 분리해 "추정"이라고 밝혀 보여준다.
--
-- 네이버가 주는 건 **그날 상위 5개 창구**뿐이라 과거 소급이 안 된다 — 이 표는
-- 워크플로가 처음 도는 날부터 쌓인다. 해당 증권사가 그날 6위 밖이면 그날은 빠지므로
-- 추정 진행률은 실제보다 낮게 나올 수 있다.
create table if not exists broker_trading (
  market      text not null check (market in ('KR', 'US')),
  ticker      text not null,
  name        text,
  date        date not null,
  broker      text not null,
  buy_qty     numeric,
  sell_qty    numeric,
  net_qty     numeric,
  -- 순매수 수량 × 종가. investor_flow와 같은 근사 방식이다.
  net_amount  numeric,
  source      text,
  updated_at  timestamptz not null default now(),
  primary key (market, ticker, date, broker)
);

create index if not exists broker_trading_ticker_date_idx
  on broker_trading (market, ticker, date desc);

-- 자사주 표에 위탁증권사와 추정 진행률 열을 추가한다.
-- amount_progress_pct(확정, 결과보고서 기반)와 estimated_progress_pct(추정, 창구 기반)를
-- 따로 두는 게 핵심이다 — 합치면 화면에서 어느 근거인지 알 수 없게 된다.
alter table stock_buyback add column if not exists broker text;
alter table stock_buyback add column if not exists estimated_qty numeric;
alter table stock_buyback add column if not exists estimated_amount numeric;
alter table stock_buyback add column if not exists estimated_progress_pct numeric;
-- 며칠치를 실제로 관측했는지. 적으면 추정치를 믿을 근거도 약하다는 뜻이라
-- 화면이 "N일 관측"으로 같이 보여준다.
alter table stock_buyback add column if not exists observed_days int;

-- ---------------------------------------------------------------------------
-- 자기주식 매매 체결내역 (KRX KIND) — 자사주 진행률의 **확정** 근거
-- ---------------------------------------------------------------------------
--
-- `/api/trstk/traded`가 종목별·일자별 신청수량과 체결수량을 그대로 준다
-- (2026-09-11 실측: SK하이닉스 8/20~ 17영업일, 매일 650,000주 체결).
--
-- **broker_trading(창구 추정)과 목적이 겹치지만 성격이 정반대다.** 창구 추정은
-- 과거 소급이 안 되고 남의 주문이 섞이는 추정치인 반면, 이 표는 거래소가 공시한
-- 확정치이고 **소급도 된다**. 그래서 진행률 근거 우선순위에서 이쪽이 위다.
-- 창구 추정은 이 값이 없는 종목의 차선책으로 남긴다.
create table if not exists buyback_trades (
  market      text not null check (market in ('KR', 'US')),
  ticker      text not null,
  name        text,
  date        date not null,
  -- 신청수량은 전영업일 저녁에, 체결수량은 18시 이후에 확정 공시된다.
  -- 둘 다 두는 이유: 당일 장중에는 신청만 있고 체결이 아직 안 붙는다.
  applied_qty numeric,
  traded_qty  numeric,
  source      text,
  updated_at  timestamptz not null default now(),
  primary key (market, ticker, date)
);

create index if not exists buyback_trades_ticker_date_idx
  on buyback_trades (market, ticker, date desc);

-- 자사주 표에 확정 진행률 열을 추가한다.
-- amount_progress_pct(결과보고서 기반, 프로그램 종료 후에만 나옴)와 **다른 값**이다 —
-- 이쪽은 진행 중에도 매일 갱신된다. 합치면 화면에서 어느 근거인지 알 수 없게 된다.
alter table stock_buyback add column if not exists confirmed_qty numeric;
alter table stock_buyback add column if not exists confirmed_progress_pct numeric;
-- 몇 영업일치가 공시됐는지. 창구 추정의 observed_days와 달리 이건 "거래소가 공시한
-- 매매일 수"라 결측이 아니다 — 화면에 근거의 두께로 같이 보여준다.
alter table stock_buyback add column if not exists confirmed_days int;
alter table stock_buyback add column if not exists confirmed_through date;
