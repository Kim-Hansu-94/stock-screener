-- Run this once in the Supabase SQL editor.
--
-- Fixes the "statement timeout" on the /discover 미래먹거리 screener after the
-- KOSPI 3-year backfill (600k+ rows). get_opp_drawdowns scans every universe
-- ticker's close history to compute the 3y high / latest close; without a
-- covering index each matching row needs a heap fetch, so the full-universe
-- scan blows past statement_timeout when US + KR run together.
--
-- INCLUDE (close) makes it an index-only scan. CONCURRENTLY avoids locking the
-- table during the build (must be run outside a transaction block).

create index concurrently if not exists idx_sph_market_ticker_date_close
  on stock_price_history (market, ticker, date) include (close);
