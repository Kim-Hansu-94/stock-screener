from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Callable

import pandas as pd

from . import prices_kr, prices_us, sectors, universe_kr, universe_us
from .indicators import rsi
from .market_regime import determine_market_regime
from .screener import passes_pullback_filter

SECTOR_DETECTION_LOOKBACK_DAYS = 45
FULL_HISTORY_LOOKBACK_DAYS = 200
# 380 calendar days ≈ 263 trading days — covers full 52-week high via KIS pagination.
US_UNIVERSE_HISTORY_LOOKBACK_DAYS = 380
INDEX_LOOKBACK_DAYS = 400
KR_MIN_MARKET_CAP = 300_000_000_000
US_MIN_MARKET_CAP = 200_000_000


@dataclass
class ScreenedStock:
    ticker: str
    name: str
    sector: str
    close: float
    market_cap: float
    rsi: float


@dataclass
class MarketPipelineResult:
    market: str
    regime: str
    leading_sectors: list[str] = field(default_factory=list)
    screened_stocks: list[ScreenedStock] = field(default_factory=list)
    price_history: dict[str, pd.DataFrame] = field(default_factory=dict)
    universe_df: pd.DataFrame = field(default_factory=pd.DataFrame)


def _build_sector_frame(universe: pd.DataFrame, recent_histories: dict[str, pd.DataFrame]) -> pd.DataFrame:
    rows = []
    for _, row in universe.iterrows():
        ticker = row["ticker"]
        hist = recent_histories.get(ticker)
        if hist is None or hist.empty:
            continue
        for idx, price_row in hist.iterrows():
            rows.append({
                "ticker": ticker, "sector": row["sector"], "date": idx,
                "close": price_row["Close"], "volume": price_row["Volume"],
            })
    return pd.DataFrame(rows)


def _screen_candidates(
    candidates: pd.DataFrame, fetch_full_history: Callable[[str], pd.DataFrame],
) -> tuple[list[ScreenedStock], dict[str, pd.DataFrame]]:
    screened: list[ScreenedStock] = []
    price_history: dict[str, pd.DataFrame] = {}
    for _, row in candidates.iterrows():
        ticker = row["ticker"]
        hist = fetch_full_history(ticker)
        if hist.empty or not passes_pullback_filter(hist["Close"], hist["Volume"]):
            continue
        screened.append(ScreenedStock(
            ticker=ticker,
            name=row["name"],
            sector=row["sector"],
            close=float(hist["Close"].iloc[-1]),
            market_cap=float(row["market_cap"]),
            rsi=float(rsi(hist["Close"]).iloc[-1]),
        ))
        price_history[ticker] = hist.tail(120)
    return screened, price_history


def run_kr_pipeline(today: date) -> MarketPipelineResult:
    universe = universe_kr.get_kr_universe(min_market_cap=KR_MIN_MARKET_CAP)

    index_close = prices_kr.get_kospi_index_history(today, INDEX_LOOKBACK_DAYS)
    regime = determine_market_regime(index_close)

    recent_histories = {
        ticker: prices_kr.get_kr_stock_history(ticker, today, SECTOR_DETECTION_LOOKBACK_DAYS)
        for ticker in universe["ticker"]
    }
    sector_df = _build_sector_frame(universe, recent_histories)
    top_sectors = sectors.leading_sectors(sector_df, top_n=3) if not sector_df.empty else []

    # 시장 국면이 bull일 때만 스크리닝 (bear 구간 신호 억제)
    if regime == "bull":
        candidates = universe[universe["sector"].isin(top_sectors) & universe["meets_cap_threshold"]]
        screened, price_history = _screen_candidates(
            candidates, lambda t: prices_kr.get_kr_stock_history(t, today, FULL_HISTORY_LOOKBACK_DAYS),
        )
    else:
        screened, price_history = [], {}

    return MarketPipelineResult(
        market="KR", regime=regime, leading_sectors=top_sectors,
        screened_stocks=screened, price_history=price_history,
        universe_df=universe,
    )


def run_us_pipeline(today: date) -> MarketPipelineResult:
    universe = universe_us.get_us_universe()
    market_caps = prices_us.get_us_market_caps(universe["ticker"].tolist())
    universe = universe.copy()
    universe["market_cap"] = universe["ticker"].map(market_caps).fillna(0.0)
    universe["meets_cap_threshold"] = universe["market_cap"] >= US_MIN_MARKET_CAP

    index_close = prices_us.get_sp500_index_history(today, INDEX_LOOKBACK_DAYS)
    regime = determine_market_regime(index_close)

    # Single batch download for the full universe: replaces the previous two separate
    # downloads (45-day sector detection + 200-day screener). Also provides history for
    # chart similarity search and opportunity detection features.
    all_histories = prices_us.get_us_stock_histories(
        universe["ticker"].tolist(), today, US_UNIVERSE_HISTORY_LOOKBACK_DAYS,
    )
    sector_df = _build_sector_frame(universe, all_histories)
    top_sectors = sectors.leading_sectors(sector_df, top_n=3) if not sector_df.empty else []

    # 시장 국면이 bull일 때만 스크리닝 (bear 구간 신호 억제)
    if regime == "bull":
        candidates = universe[universe["sector"].isin(top_sectors) & universe["meets_cap_threshold"]]
        screened, _ = _screen_candidates(candidates, lambda t: all_histories.get(t, pd.DataFrame()))
    else:
        screened = []

    return MarketPipelineResult(
        market="US", regime=regime, leading_sectors=top_sectors,
        screened_stocks=screened,
        price_history=all_histories,
        universe_df=universe,
    )
