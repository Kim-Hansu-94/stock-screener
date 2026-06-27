from __future__ import annotations

import json
import pathlib
import pickle
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

_EXCH_CACHE_FILE  = pathlib.Path(__file__).parent.parent / ".kis_exch_cache.json"
_PRICE_CACHE_FILE = pathlib.Path(__file__).parent.parent / ".kis_price_cache.pkl"
_MAX_CACHE_DAYS   = 210  # 캐시 최대 보존 일수 (lookback_days + 여유)

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


def _load_price_cache() -> dict[str, pd.DataFrame]:
    if _PRICE_CACHE_FILE.exists():
        try:
            return pickle.loads(_PRICE_CACHE_FILE.read_bytes())
        except Exception:
            return {}
    return {}


def _save_price_cache(cache: dict[str, pd.DataFrame]) -> None:
    try:
        _PRICE_CACHE_FILE.write_bytes(pickle.dumps(cache))
    except Exception:
        pass


def _last_us_trading_day(ref: date) -> date:
    """파이프라인 실행 시점(KST 08:00)에 이미 확정된 마지막 미국 거래일."""
    d = ref - timedelta(days=1)
    while d.weekday() >= 5:  # 토(5)·일(6) 건너뜀
        d -= timedelta(days=1)
    return d


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
        time.sleep(0.1)
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


def _rows_to_df(rows: list[dict]) -> pd.DataFrame:
    """KIS output2 행 목록을 날짜 인덱스 DataFrame으로 변환."""
    records = []
    for r in rows:
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
    return df[~df.index.duplicated(keep="last")]


def _fetch_single(ticker: str, end: date, lookback_days: int, session: req.Session) -> pd.DataFrame:
    """전체 lookback 기간을 KIS에서 새로 다운로드."""
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

    df = _rows_to_df(all_rows)
    if df.empty:
        return df
    cutoff_ts = pd.Timestamp(end - timedelta(days=lookback_days))
    return df[df.index >= cutoff_ts]


def _fetch_incremental(ticker: str, end: date, session: req.Session) -> pd.DataFrame:
    """교환소 캐시가 있을 때 최근 1페이지(≤100행)만 받아오는 빠른 업데이트."""
    excd = _exch_cache.get(ticker)
    if not excd:
        return pd.DataFrame()
    rows = _kis_daily(ticker, excd, end.strftime("%Y%m%d"), session)
    return _rows_to_df(rows)


def get_us_stock_histories(tickers: list[str], end: date, lookback_days: int) -> dict[str, pd.DataFrame]:
    """KIS API로 미국 주식 일봉 데이터를 수집.

    전략:
    - 캐시가 최신(마지막 미국 거래일까지 있음): API 호출 없이 캐시 반환
    - 캐시가 오래됐고 거래소 캐시 있음: 1페이지 증분 업데이트 (1회 호출)
    - 캐시 없음 또는 거래소 미확인: 전체 140일 다운로드 (2회 호출)
    """
    session = req.Session()
    cache = _load_price_cache()
    results: dict[str, pd.DataFrame] = {}
    cutoff_ts = pd.Timestamp(end - timedelta(days=lookback_days))
    trim_ts   = pd.Timestamp(end - timedelta(days=_MAX_CACHE_DAYS))

    latest_expected_ts = pd.Timestamp(_last_us_trading_day(end))

    total = len(tickers)
    api_calls = 0

    for i, ticker in enumerate(tickers, 1):
        if i % 200 == 0 or i == total:
            print(f"  KIS 가격 다운로드: {i}/{total} (API 호출={api_calls})", flush=True)

        cached = cache.get(ticker)

        # ── 캐시 최신 → 즉시 반환 ──────────────────────────────────
        if cached is not None and not cached.empty:
            if cached.index.max() >= latest_expected_ts:
                df_out = cached[cached.index >= cutoff_ts]
                if not df_out.empty:
                    results[ticker] = df_out
                continue

        # ── 캐시 오래됨 + 거래소 알고 있음 → 증분 1회 ──────────────
        if cached is not None and not cached.empty and ticker in _exch_cache:
            try:
                df_new = _fetch_incremental(ticker, end, session)
                api_calls += 1
            except Exception:
                df_new = pd.DataFrame()

            if not df_new.empty:
                df_merged = pd.concat([cached, df_new]).sort_index()
                df_merged = df_merged[~df_merged.index.duplicated(keep="last")]
                df_merged = df_merged[df_merged.index >= trim_ts]
                cache[ticker] = df_merged
                df_out = df_merged[df_merged.index >= cutoff_ts]
                if not df_out.empty:
                    results[ticker] = df_out
            else:
                # 증분 실패 → 오래된 캐시라도 패턴 계산에 사용
                df_out = cached[cached.index >= cutoff_ts]
                if not df_out.empty:
                    results[ticker] = df_out
            continue

        # ── 캐시 없음 또는 거래소 미확인 → 전체 다운로드 ──────────
        try:
            df = _fetch_single(ticker, end, lookback_days, session)
            api_calls += 2  # 교환소 탐색 + 데이터 2페이지 평균
            if not df.empty:
                cache[ticker] = df
                results[ticker] = df
        except Exception:
            pass

    _save_price_cache(cache)
    _save_exch_cache()
    return results
