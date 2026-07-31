"""장기(10년) 월봉 수집.

stock_price_history는 3년치 일봉만 보관한다. 그래서 횡보·조정 스크리너가 쓰는
"3년 고점"이 이미 하락이 한참 진행된 뒤의 낮은 고점일 수 있고, 실제 최고점
(예: IFF의 2021년 고점) 대비 하락폭은 화면에 전혀 드러나지 않았다.

과거 월봉은 확정된 값이라 다시 받을 필요가 없으므로, 아직 시드하지 않은 종목만
10년치를 1회 수집한다. 정상 운영 중에는 지수 신규 편입 종목만 대상이 되어
추가 비용이 사실상 없다. 최근 구간은 프론트가 mv_monthly_ohlcv와 합쳐 읽는다.
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import yfinance as yf

from . import prices_kr
from .db import ScreenerDB

LONG_YEARS = 10
_LONG_DAYS = LONG_YEARS * 365

_SEEDED_FILE = Path(__file__).resolve().parent.parent / ".long_monthly_seeded_tickers"


def _to_monthly(df: pd.DataFrame) -> pd.DataFrame:
    """일봉 DataFrame(DatetimeIndex)을 월봉으로 집계."""
    if df.empty:
        return df
    frame = df.copy()
    if not isinstance(frame.index, pd.DatetimeIndex):
        frame.index = pd.to_datetime(frame.index)
    agg = {"Open": "first", "High": "max", "Low": "min", "Close": "last"}
    if "Volume" in frame.columns:
        agg["Volume"] = "sum"
    return frame.resample("MS").agg(agg).dropna(subset=["Close"])


def _rows(ticker: str, market: str, monthly: pd.DataFrame) -> list[dict]:
    out: list[dict] = []
    for idx, row in monthly.iterrows():
        month_start = idx.date() if hasattr(idx, "date") else pd.to_datetime(idx).date()
        out.append({
            "ticker": ticker,
            "market": market,
            "month_start": month_start.replace(day=1).isoformat(),
            "open": float(row["Open"]),
            "high": float(row["High"]),
            "low": float(row["Low"]),
            "close": float(row["Close"]),
            "volume": int(row["Volume"]) if "Volume" in monthly.columns and pd.notna(row["Volume"]) else 0,
        })
    return out


def _load_seeded() -> set[str]:
    if not _SEEDED_FILE.exists():
        return set()
    try:
        return set(json.loads(_SEEDED_FILE.read_text()))
    except (json.JSONDecodeError, OSError):
        return set()


def _save_seeded(seeded: set[str]) -> None:
    _SEEDED_FILE.write_text(json.dumps(sorted(seeded)))


def _collect_us(tickers: list[str], today: date) -> list[dict]:
    """yfinance 월봉 배치 다운로드 — 10년치도 호출 한 번이라 비용이 낮다."""
    rows: list[dict] = []
    start = (today - timedelta(days=_LONG_DAYS)).isoformat()
    chunk = 100
    for i in range(0, len(tickers), chunk):
        batch = tickers[i : i + chunk]
        print(f"  US 장기 월봉: {min(i + chunk, len(tickers))}/{len(tickers)}", flush=True)
        try:
            raw = yf.download(
                batch, start=start, end=today.isoformat(), interval="1mo", progress=False,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"  US 장기 월봉 배치 실패: {exc}", flush=True)
            continue
        if raw is None or raw.empty:
            continue
        if isinstance(raw.columns, pd.MultiIndex):
            for ticker in batch:
                try:
                    df = raw.xs(ticker, axis=1, level=1).dropna(subset=["Close"])
                except (KeyError, AttributeError):
                    continue
                if not df.empty:
                    rows.extend(_rows(ticker, "US", df))
        else:
            df = raw.dropna(subset=["Close"])
            if not df.empty:
                rows.extend(_rows(batch[0], "US", df))
    return rows


def _collect_kr(tickers: list[str], today: date) -> list[dict]:
    """FinanceDataReader 종목별 조회 후 월봉 집계 (배치 API가 없어 순차)."""
    rows: list[dict] = []
    failed = 0
    for n, ticker in enumerate(tickers, 1):
        if n % 100 == 0:
            print(f"  KR 장기 월봉: {n}/{len(tickers)}", flush=True)
        try:
            daily = prices_kr.get_kr_stock_history(ticker, today, _LONG_DAYS)
        except Exception:  # noqa: BLE001
            failed += 1
            continue
        monthly = _to_monthly(daily)
        if not monthly.empty:
            rows.extend(_rows(ticker, "KR", monthly))
    if failed:
        print(f"  KR 장기 월봉 실패 {failed}개", flush=True)
    return rows


def seed_long_monthly(db: ScreenerDB, market: str, tickers: list[str], today: date) -> None:
    """아직 시드하지 않은 종목만 10년 월봉을 수집·저장한다."""
    if not tickers:
        return
    seeded = _load_seeded()
    pending = [t for t in tickers if f"{market}:{t}" not in seeded]
    if not pending:
        return

    print(f"{market} 장기 월봉 시드 ({len(pending)}개)...", flush=True)
    try:
        rows = _collect_us(pending, today) if market == "US" else _collect_kr(pending, today)
        if rows:
            db.save_long_monthly(rows)
        print(f"  → {len(rows)}행 저장", flush=True)
        seeded.update(f"{market}:{t}" for t in pending)
        _save_seeded(seeded)
    except Exception as exc:  # noqa: BLE001
        # 테이블 미생성 등으로 실패해도 파이프라인 본체는 계속 진행한다.
        print(f"  {market} 장기 월봉 시드 실패: {exc}", flush=True)
