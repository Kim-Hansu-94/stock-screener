from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv

from . import prices_us
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
        clean = hist.tail(380).dropna(subset=["Open", "High", "Low", "Close", "Volume"])
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
                "name_kr": row.get("name_kr", ""),
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

    # S&P500 + NASDAQ100 종목 히스토리 (기회 종목 스크리너용)
    # .yfinance_opp_seeded 파일(actions/cache로 유지)로 증분 여부 판단
    print("기회 종목 히스토리 수집 중...", flush=True)
    opp_mask = us_result.universe_df["index_membership"].isin(["NASDAQ100", "S&P500"])
    opp_tickers = us_result.universe_df.loc[opp_mask, "ticker"].tolist()

    from pathlib import Path
    _seed_file = Path(__file__).parent.parent / ".yfinance_opp_seeded"
    if _seed_file.exists():
        seed_date = date.fromisoformat(_seed_file.read_text().strip())
        lookback_days = max((today - seed_date).days + 7, 14)
        print(f"  증분 업데이트: {seed_date} 이후 {lookback_days}일", flush=True)
    else:
        lookback_days = 1095
        print("  최초 실행: 3년 전체 다운로드", flush=True)

    opp_histories = prices_us.get_opportunity_histories(opp_tickers, today, lookback_days=lookback_days)
    opp_rows: list[dict] = []
    for ticker, hist in opp_histories.items():
        for idx, row in hist.iterrows():
            opp_rows.append({
                "ticker": ticker,
                "market": "US",
                "date": idx.date().isoformat() if hasattr(idx, "date") else str(idx)[:10],
                "open": float(row.get("Open", 0)),
                "high": float(row.get("High", 0)),
                "low": float(row.get("Low", 0)),
                "close": float(row.get("Close", 0)),
                "volume": int(row.get("Volume", 0)),
            })
    db.save_price_history(opp_rows)
    print(f"  → {len(opp_rows)}행 저장", flush=True)
    _seed_file.write_text(today.isoformat())

    print("Gold Standard 패턴 유사도 계산 중...", flush=True)
    matches = compute_pattern_matches(us_result.price_history, us_result.universe_df)
    db.save_pattern_matches(matches, today.isoformat())


if __name__ == "__main__":
    main()
