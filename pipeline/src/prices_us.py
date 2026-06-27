from __future__ import annotations

import json
import pathlib
import time
from datetime import date, timedelta

import pandas as pd
import requests as req
import yfinance as yf

from .kis_auth import headers as _kis_headers

SP500_INDEX_TICKER = "^GSPC"
_KIS_BASE = "https://openapi.koreainvestment.com:9443"
_EXCHANGES = ["NAS", "NYS", "AMS"]

# KIS HHDFS76240000 실제 필드명 (테스트로 확인)
_DATE_KEY   = "xymd"
_CLOSE_KEYS = ["clos", "ovrs_nmix_prpr", "ovrs_stck_clpr"]
_OPEN_KEYS  = ["open", "ovrs_nmix_oprc", "ovrs_stck_oprc"]
_HIGH_KEYS  = ["high", "ovrs_nmix_hgpr", "ovrs_stck_hgpr"]
_LOW_KEYS   = ["low",  "ovrs_nmix_lwpr", "ovrs_stck_lwpr"]
_VOL_KEYS   = ["tvol", "acml_vol", "vol"]

_EXCH_CACHE_FILE = pathlib.Path(__file__).parent.parent / ".kis_exch_cache.json"
_exch_cache: dict[str, str] = {}


def _load_exch_cache() -> None:
    if _EXCH_CACHE_FILE.exists():
        try:
            _exch_cache.update(json.loads(_EXCH_CACHE_FILE.read_text(encoding="utf-8")))
        except Exception:
            pass


def _save_exch_cache() -> None:
    try:
        _EXCH_CACHE_FILE.write_text(json.dumps(_exch_cache), encoding="utf-8")
    except Exception:
        pass


_load_exch_cache()


def get_sp500_index_history(end: date, lookback_days: int) -> pd.Series:
    start = end - timedelta(days=lookback_days)
    df = yf.download(SP500_INDEX_TICKER, start=start.isoformat(), end=end.isoformat(), progress=False)
    return df["Close"][SP500_INDEX_TICKER]


def get_us_market_caps(tickers: list[str]) -> dict[str, float]:
    caps: dict[str, float] = {}
    for ticker in tickers:
        try:
            caps[ticker] = float(yf.Ticker(ticker).fast_info["marketCap"])
        except Exception:
            caps[ticker] = 0.0
    return caps


def _first(row: dict, keys: list[str]) -> str:
    """키 후보 목록에서 값이 있는 첫 번째 필드를 반환."""
    for k in keys:
        v = row.get(k, "")
        if v and str(v).strip() not in ("", "0", "."):
            return str(v)
    return ""


def _kis_daily(ticker: str, excd: str, bymd: str, session: req.Session) -> list[dict]:
    """KIS 해외주식 기간별시세 1회 호출. 성공 시 output2 리스트, 실패 시 []."""
    for attempt in range(3):
        try:
            resp = session.get(
                f"{_KIS_BASE}/uapi/overseas-price/v1/quotations/dailyprice",
                headers=_kis_headers("HHDFS76240000"),
                params={
                    "AUTH": "",
                    "EXCD": excd,
                    "SYMB": ticker,
                    "GUBN": "0",
                    "BYMD": bymd,
                    "MODP": "1",
                },
                timeout=10,
            )
        except req.RequestException:
            return []
        time.sleep(0.2)
        try:
            body = resp.json()
        except Exception:
            return []
        rt_cd = body.get("rt_cd")
        # KIS는 TPS 초과 시 HTTP 500 + rt_cd="1" 반환 — HTTP 상태와 무관하게 retry
        if rt_cd == "1":
            time.sleep(1.5 * (attempt + 1))
            continue
        if resp.status_code != 200 or rt_cd != "0":
            return []
        rows = body.get("output2") or []
        return [r for r in rows if _first(r, _CLOSE_KEYS)]
    return []


def _fetch_single(ticker: str, end: date, lookback_days: int, session: req.Session) -> pd.DataFrame:
    end_str = end.strftime("%Y%m%d")
    cutoff = end - timedelta(days=lookback_days)

    excd = _exch_cache.get(ticker)
    all_rows: list[dict] = []
    last_chunk_len = 0

    if not excd:
        for ex in _EXCHANGES:
            probe = _kis_daily(ticker, ex, end_str, session)
            if probe:
                excd = ex
                _exch_cache[ticker] = ex
                all_rows = probe
                last_chunk_len = len(probe)
                break
        if not excd:
            return pd.DataFrame()

    fetch_bymd = end_str
    while True:
        if not all_rows:
            chunk = _kis_daily(ticker, excd, fetch_bymd, session)
            if not chunk:
                return pd.DataFrame()
            all_rows.extend(chunk)
            last_chunk_len = len(chunk)

        oldest_str = min(r[_DATE_KEY] for r in all_rows)
        oldest_date = date(int(oldest_str[:4]), int(oldest_str[4:6]), int(oldest_str[6:8]))
        if oldest_date <= cutoff or last_chunk_len < 100:
            break

        fetch_bymd = (oldest_date - timedelta(days=1)).strftime("%Y%m%d")
        chunk = _kis_daily(ticker, excd, fetch_bymd, session)
        if not chunk:
            break
        all_rows.extend(chunk)
        last_chunk_len = len(chunk)

    if not all_rows:
        return pd.DataFrame()

    records = []
    for r in all_rows:
        c = _first(r, _CLOSE_KEYS)
        if not c:
            continue
        records.append({
            "date":   pd.Timestamp(r[_DATE_KEY]),
            "Open":   float(_first(r, _OPEN_KEYS) or c),
            "High":   float(_first(r, _HIGH_KEYS) or c),
            "Low":    float(_first(r, _LOW_KEYS) or c),
            "Close":  float(c),
            "Volume": int(float(_first(r, _VOL_KEYS) or "0")),
        })

    if not records:
        return pd.DataFrame()

    df = pd.DataFrame(records).set_index("date").sort_index()
    df = df[~df.index.duplicated(keep="last")]
    cutoff = pd.Timestamp(end - timedelta(days=lookback_days))
    return df[df.index >= cutoff]


def get_us_stock_histories(tickers: list[str], end: date, lookback_days: int) -> dict[str, pd.DataFrame]:
    """KIS API로 미국 주식 일봉 데이터를 수집. Yahoo Finance 배치 다운로드 대체."""
    session = req.Session()
    results: dict[str, pd.DataFrame] = {}
    total = len(tickers)
    for i, ticker in enumerate(tickers, 1):
        if i % 200 == 0 or i == total:
            print(f"  KIS 가격 다운로드: {i}/{total}", flush=True)
        try:
            df = _fetch_single(ticker, end, lookback_days, session)
            if not df.empty:
                results[ticker] = df
        except Exception:
            pass
    _save_exch_cache()
    return results
