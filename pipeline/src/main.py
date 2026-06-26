from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv

from .db import PipelineResult, ScreenerDB
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
        for _, row in result.universe_df.iterrows():
            universe_rows.append({
                "ticker": row["ticker"],
                "market": result.market,
                "name": row.get("name", "") or "",
                "sector": row.get("sector", "") or "",
                "index_membership": row.get("index_membership", "") or "",
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
    for result in (run_kr_pipeline(today), run_us_pipeline(today)):
        db.save_pipeline_result(_to_db_result(result, today))


if __name__ == "__main__":
    main()
