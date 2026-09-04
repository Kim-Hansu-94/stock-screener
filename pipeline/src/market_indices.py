"""홈 화면 시황 위젯용 지수 스냅샷 수집 (코스피·코스닥·다우존스·나스닥·S&P500).

차트가 아니라 "지금 얼마고 전일 대비 몇 % 인지"만 보여주면 되므로, 전체 이력을
쌓지 않고 최신 종가·직전 종가만 매 실행 덮어쓴다(save_market_index_snapshots가
upsert). 환율은 프론트가 frankfurter.app에서 직접 받아오므로(fetchUsdKrwRate)
여기서는 다루지 않는다.
"""
from __future__ import annotations

from datetime import date, timedelta

import FinanceDataReader as fdr
import yfinance as yf

# 연휴 등으로 며칠 비어도 최신·직전 종가 둘 다 확보할 수 있게 여유를 둔다.
_LOOKBACK_DAYS = 10

# (표시 이름, FinanceDataReader 티커)
_KR_INDEXES = [
    ("코스피", "KS11"),
    ("코스닥", "KQ11"),
]

# (표시 이름, yfinance 티커)
_US_INDEXES = [
    ("다우존스", "^DJI"),
    ("나스닥", "^IXIC"),
    ("S&P500", "^GSPC"),
]


def _snapshot_from_closes(name: str, dates: list, closes: list[float]) -> dict | None:
    if len(closes) < 2:
        return None
    return {
        "index_name": name,
        "date": dates[-1],
        "close": float(closes[-1]),
        "prev_close": float(closes[-2]),
    }


def _kr_snapshot(name: str, ticker: str, today: date) -> dict | None:
    start = today - timedelta(days=_LOOKBACK_DAYS)
    df = fdr.DataReader(ticker, start.isoformat(), today.isoformat())
    closes = df["Close"].dropna()
    return _snapshot_from_closes(name, [d.date().isoformat() for d in closes.index], list(closes))


def _us_snapshot(name: str, ticker: str, today: date) -> dict | None:
    start = today - timedelta(days=_LOOKBACK_DAYS)
    df = yf.download(ticker, start=start.isoformat(), end=today.isoformat(), progress=False)
    if df.empty:
        return None
    closes = df["Close"][ticker].dropna()
    return _snapshot_from_closes(name, [d.date().isoformat() for d in closes.index], list(closes))


def collect_market_index_snapshots(today: date) -> list[dict]:
    snapshots: list[dict] = []
    for name, ticker in _KR_INDEXES:
        try:
            snap = _kr_snapshot(name, ticker, today)
        except Exception as exc:  # noqa: BLE001
            print(f"  시황 지수 수집 실패 ({name}): {exc}", flush=True)
            continue
        if snap:
            snapshots.append(snap)
    for name, ticker in _US_INDEXES:
        try:
            snap = _us_snapshot(name, ticker, today)
        except Exception as exc:  # noqa: BLE001
            print(f"  시황 지수 수집 실패 ({name}): {exc}", flush=True)
            continue
        if snap:
            snapshots.append(snap)
    return snapshots
