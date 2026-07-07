"""KOSPI 기회 종목 3년 OHLCV 백필.

미장의 `get_opportunity_histories(..., lookback_days=1095)` 백필(main.py)에
대응하는 국장 버전. `stock_universe`의 KOSPI 종목 전체에 대해 3년치 일봉을
`stock_price_history`(market='KR')에 채워, "미래먹거리 횡보·조정" 스크리너가
국장 종목을 계산할 수 있게 한다.

실행:  python -m src.backfill_kr_opportunities
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv

from . import prices_kr
from .db import ScreenerDB

KST = timezone(timedelta(hours=9))
LOOKBACK_DAYS = 1095  # 3년
FLUSH_EVERY_ROWS = 5_000  # 이 이상 쌓이면 중간 저장


def _today_kst() -> date:
    return datetime.now(KST).date()


def _fetch_kospi_tickers(db: ScreenerDB) -> list[str]:
    """stock_universe에서 KOSPI 티커를 페이지네이션으로 전부 조회."""
    page_size = 1_000
    tickers: list[str] = []
    start = 0
    while True:
        resp = (
            db.client.table("stock_universe")
            .select("ticker")
            .eq("market", "KR")
            .eq("index_membership", "KOSPI")
            .range(start, start + page_size - 1)
            .execute()
        )
        data = resp.data or []
        tickers.extend(r["ticker"] for r in data)
        if len(data) < page_size:
            break
        start += page_size
    return tickers


def _history_rows(ticker: str, hist) -> list[dict]:
    clean = hist.dropna(subset=["Open", "High", "Low", "Close", "Volume"])
    rows: list[dict] = []
    for idx, row in clean.iterrows():
        rows.append({
            "ticker": ticker,
            "market": "KR",
            "date": idx.date().isoformat() if hasattr(idx, "date") else str(idx)[:10],
            "open": float(row["Open"]),
            "high": float(row["High"]),
            "low": float(row["Low"]),
            "close": float(row["Close"]),
            "volume": int(row["Volume"]),
        })
    return rows


def main() -> None:
    load_dotenv()
    today = _today_kst()
    db = ScreenerDB.from_env()

    tickers = _fetch_kospi_tickers(db)
    print(f"KOSPI 3년 백필 시작: {len(tickers)}개 종목 (lookback {LOOKBACK_DAYS}일)", flush=True)

    pending: list[dict] = []
    saved_rows = 0
    saved_tickers = 0
    failed = 0

    for i, ticker in enumerate(tickers, 1):
        try:
            hist = prices_kr.get_kr_stock_history(ticker, today, LOOKBACK_DAYS)
        except Exception:
            failed += 1
            continue
        if hist.empty:
            continue
        pending.extend(_history_rows(ticker, hist))
        saved_tickers += 1

        if len(pending) >= FLUSH_EVERY_ROWS:
            db.save_price_history(pending)
            saved_rows += len(pending)
            pending = []

        if i % 50 == 0:
            print(
                f"  {i}/{len(tickers)} 진행 · 저장 {saved_rows}행 · 실패 {failed}",
                flush=True,
            )

    if pending:
        db.save_price_history(pending)
        saved_rows += len(pending)

    print(
        f"완료: {saved_tickers}개 종목 · {saved_rows}행 저장 · 실패 {failed}개",
        flush=True,
    )


if __name__ == "__main__":
    main()
