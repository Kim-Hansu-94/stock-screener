-- Run this once in the Supabase SQL editor.
-- Fixes the "statement timeout" on the /discover 미래먹거리 screener: getDailyBars
-- selects close/high/low/volume, but idx_sph_market_ticker_date_close only
-- INCLUDEs close, so every row needs a heap fetch — too slow on a cold cache
-- with dozens of concurrent batch queries.
-- INCLUDE-ing all four columns makes it an index-only scan.
-- CONCURRENTLY avoids locking, so run it outside a transaction block.
create index concurrently if not exists idx_sph_daily_bars
  on stock_price_history (market, ticker, date)
  include (close, high, low, volume);

-- Optional cleanup: the new index fully covers the old one, so it can be dropped
-- to save space once the new index is built.
-- drop index concurrently if exists idx_sph_market_ticker_date_close;
