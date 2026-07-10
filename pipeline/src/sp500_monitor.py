from __future__ import annotations

from datetime import date, timedelta

import pandas as pd
import yfinance as yf

from . import prices_kr

SP500_TICKER = "^GSPC"
ETF_TICKER = "360750"
ETF_NAME = "TIGER 미국S&P500"
HIGH_LOOKBACK_DAYS = 252
# 표시 3년 + 52주 고점 계산 여유. 수신 첫 1년은 축소 윈도우 근사(참고 데이터라 허용).
LOOKBACK_DAYS = 1460


def compute_daily_state(close: pd.Series) -> pd.DataFrame:
    """지수 종가에서 52주(252거래일) 고점과 고점 대비 하락률(%)을 계산한다."""
    high_52w = close.rolling(HIGH_LOOKBACK_DAYS, min_periods=1).max()
    drawdown_pct = (close / high_52w - 1.0) * 100.0
    return pd.DataFrame({
        "close": close, "high_52w": high_52w, "drawdown_pct": drawdown_pct,
    })


def daily_rows(daily: pd.DataFrame) -> list[dict]:
    return [
        {
            "date": idx.date().isoformat(),
            "close": round(float(row["close"]), 2),
            "high_52w": round(float(row["high_52w"]), 2),
            "drawdown_pct": round(float(row["drawdown_pct"]), 2),
        }
        for idx, row in daily.iterrows()
    ]


def fetch_index_history(today: date) -> pd.Series:
    start = today - timedelta(days=LOOKBACK_DAYS)
    df = yf.download(SP500_TICKER, start=start.isoformat(), auto_adjust=True, progress=False)
    close = df["Close"]
    if isinstance(close, pd.DataFrame):
        close = close[SP500_TICKER]
    return close.dropna()


def etf_quote_row(hist: pd.DataFrame) -> dict:
    close = hist["Close"].dropna()
    last = float(close.iloc[-1])
    prev = float(close.iloc[-2]) if len(close) >= 2 else last
    idx = close.index[-1]
    return {
        "ticker": ETF_TICKER,
        "name": ETF_NAME,
        "close": round(last, 2),
        "change_pct": round((last / prev - 1.0) * 100.0, 2),
        "currency": "KRW",
        "as_of": (idx.date() if hasattr(idx, "date") else idx).isoformat(),
    }


def etf_history_rows(hist: pd.DataFrame) -> list[dict]:
    clean = hist.dropna(subset=["Open", "High", "Low", "Close", "Volume"])
    return [
        {
            "ticker": ETF_TICKER,
            "market": "KR",
            "date": idx.date().isoformat() if hasattr(idx, "date") else str(idx)[:10],
            "open": float(row["Open"]),
            "high": float(row["High"]),
            "low": float(row["Low"]),
            "close": float(row["Close"]),
            "volume": int(row["Volume"]),
        }
        for idx, row in clean.iterrows()
    ]


def run(db, today: date) -> None:
    """일일 파이프라인 진입점. sp500_daily는 비어 있으면 전체, 이후 최근 30일 창만 upsert."""
    close = fetch_index_history(today)
    daily = compute_daily_state(close)
    rows = daily_rows(daily)

    latest = db.get_sp500_latest_date()
    if latest:
        cutoff = (date.fromisoformat(latest) - timedelta(days=30)).isoformat()
        rows = [r for r in rows if r["date"] >= cutoff]
    db.save_sp500_daily(rows)

    # TIGER 시세·일봉은 표시용 — 실패해도 지수 데이터 저장에는 영향 없음
    try:
        hist = prices_kr.get_kr_stock_history(ETF_TICKER, today, LOOKBACK_DAYS)
        db.save_price_history(etf_history_rows(hist))
        db.save_sp500_etf_quotes([etf_quote_row(hist)])
    except Exception as exc:
        print(f"  TIGER 시세 수집 실패 (건너뜀): {exc}", flush=True)

    print(f"  sp500_daily {len(rows)}행, 기준일 {daily.index[-1].date()}", flush=True)
