from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv

from .db import PipelineResult, ScreenerDB
from .pattern_discovery import compute_pattern_matches
from .pipeline import MarketPipelineResult, run_kr_pipeline, run_us_pipeline

KST = timezone(timedelta(hours=9))


def _today_kst() -> date:
    return datetime.now(KST).date()


def _to_db_result(result: MarketPipelineResult, today: date) -> PipelineResult:
    screened_rows = [
        {
            "ticker": s.ticker, "name": s.name, "sector": s.sector,
            "close": s.close, "market_cap": s.market_cap, "rsi": s.rsi,
        }
        for s in result.screened_stocks
    ]

    history_rows = []
    for ticker, hist in result.price_history.items():
        clean = hist.tail(120).dropna(subset=["Open", "High", "Low", "Close", "Volume"])
        for idx, row in clean.iterrows():
            history_rows.append({
                "ticker": ticker,
                "market": result.market,
                "date": idx.date().isoformat() if hasattr(idx, "date") else str(idx),
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"]),
                "volume": int(row["Volume"]),
            })

    universe_rows = []
    if not result.universe_df.empty:
        clean_universe = result.universe_df.fillna("")
        for _, row in clean_universe.iterrows():
            universe_rows.append({
                "ticker": row["ticker"],
                "market": result.market,
                "name": row.get("name", ""),
                "sector": row.get("sector", ""),
                "index_membership": row.get("index_membership", ""),
                "updated_at": today.isoformat(),
            })

    return PipelineResult(
        date=today.isoformat(),
        market=result.market,
        regime=result.regime,
        leading_sectors=result.leading_sectors,
        screened_stocks=screened_rows,
        price_history=history_rows,
        universe_metadata=universe_rows,
    )


def main() -> None:
    load_dotenv()
    today = _today_kst()
    db = ScreenerDB.from_env()

    kr_result = run_kr_pipeline(today)
    db.save_pipeline_result(_to_db_result(kr_result, today))

    us_result = run_us_pipeline(today)
    db.save_pipeline_result(_to_db_result(us_result, today))

    print("Gold Standard 패턴 유사도 계산 중...", flush=True)
    matches = compute_pattern_matches(us_result.price_history, us_result.universe_df)
    db.save_pattern_matches(matches, today.isoformat())


if __name__ == "__main__":
    main()
