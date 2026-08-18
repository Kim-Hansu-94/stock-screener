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
# 상장이 짧아 lookback을 못 채우는 게 확정된 종목. 이게 없으면 그런 종목을 매 실행
# 전체 재수집하게 되어 API 호출이 낭비된다.
_SHORT_CACHE_FILE = pathlib.Path(__file__).parent.parent / ".kis_short_history.json"
_MAX_CACHE_DAYS   = 420  # 캐시 최대 보존 일수 (lookback_days + 여유)
# 캐시가 이 날수 이상 짧으면 "덜 받아진 것"으로 보고 전체 재수집한다. 주말·휴장으로
# 며칠 어긋나는 것까지 재수집하면 낭비라 여유를 둔다.
_DEPTH_TOLERANCE_DAYS = 14
# screener.py의 SMA200_WINDOW와 같아야 한다 — 진단 로그가 "스크리너가 200일선을
# 계산할 수 있는가"를 그대로 반영하도록.
_SMA200_BARS = 200

_exch_cache: dict[str, str] = {}
# 값은 그 종목에서 KIS가 준 가장 오래된 날짜(ISO). 재수집해도 이보다 과거는 없다.
_short_history: dict[str, str] = {}


def _load_exch_cache() -> None:
    if _EXCH_CACHE_FILE.exists():
        try:
            _exch_cache.update(json.loads(_EXCH_CACHE_FILE.read_text(encoding="utf-8")))
        except Exception:
            pass


def _load_short_history() -> None:
    if _SHORT_CACHE_FILE.exists():
        try:
            _short_history.update(json.loads(_SHORT_CACHE_FILE.read_text(encoding="utf-8")))
        except Exception:
            pass


def _save_short_history() -> None:
    try:
        _SHORT_CACHE_FILE.write_text(json.dumps(_short_history), encoding="utf-8")
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
_load_short_history()


_OHLCV = ["Open", "High", "Low", "Close", "Volume"]


def get_opportunity_histories(tickers: list[str], end: date, lookback_days: int = 1095) -> dict[str, pd.DataFrame]:
    """yfinance batch download: S&P500/NASDAQ100 종목의 3년치 가격 히스토리."""
    if not tickers:
        return {}
    start = (end - timedelta(days=lookback_days)).isoformat()
    results: dict[str, pd.DataFrame] = {}
    chunk = 100

    for i in range(0, len(tickers), chunk):
        batch = tickers[i : i + chunk]
        print(f"  기회 종목 히스토리: {min(i + chunk, len(tickers))}/{len(tickers)}", flush=True)
        try:
            raw = yf.download(batch, start=start, end=end.isoformat(), progress=False)
            if raw.empty:
                continue
            if isinstance(raw.columns, pd.MultiIndex):
                for ticker in batch:
                    try:
                        df = raw.xs(ticker, axis=1, level=1)
                        cols = [c for c in _OHLCV if c in df.columns]
                        df = df[cols].dropna(subset=["Close"])
                        if not df.empty:
                            results[ticker] = df
                    except (KeyError, AttributeError):
                        pass
            else:
                cols = [c for c in _OHLCV if c in raw.columns]
                df = raw[cols].dropna(subset=["Close"])
                if not df.empty:
                    results[batch[0]] = df
        except Exception as e:
            print(f"  yfinance 오류 (batch {i // chunk + 1}): {e}", flush=True)

    return results


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

        # 캐시가 과거로 충분히 뻗어 있는지. 증분 경로는 최근 봉만 덧붙이므로 한 번 짧게
        # 캐시된 종목은 스스로 길어지지 못한다 — 그 상태로 두면 200일선이 영영 NaN이 되어
        # 스크리너가 "200일선 아래"로 잘못 떨어뜨린다. 그래서 깊이가 모자라면 전체를 다시 받는다.
        # 상장이 짧아 원래 그만큼밖에 없는 종목은 _short_history에 기록해 재수집을 반복하지 않는다.
        deep_enough = True
        if cached is not None and not cached.empty:
            known_oldest = _short_history.get(ticker)
            if known_oldest is not None:
                deep_enough = cached.index.min() <= pd.Timestamp(known_oldest)
            else:
                deep_enough = cached.index.min() <= cutoff_ts + pd.Timedelta(
                    days=_DEPTH_TOLERANCE_DAYS
                )

        # ── 캐시 최신 + 깊이 충분 → 즉시 반환 ──────────────────────
        if cached is not None and not cached.empty and deep_enough:
            if cached.index.max() >= latest_expected_ts:
                df_out = cached[cached.index >= cutoff_ts]
                if not df_out.empty:
                    results[ticker] = df_out
                continue

        # ── 캐시 오래됨 + 거래소 알고 있음 → 증분 1회 ──────────────
        if cached is not None and not cached.empty and deep_enough and ticker in _exch_cache:
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

        # ── 캐시 없음 · 거래소 미확인 · 깊이 부족 → 전체 다운로드 ──
        df = pd.DataFrame()
        try:
            df = _fetch_single(ticker, end, lookback_days, session)
            api_calls += 2  # 교환소 탐색 + 데이터 2페이지 평균
        except Exception:
            pass

        if not df.empty:
            cache[ticker] = df
            results[ticker] = df
            # 전체를 받고도 lookback을 못 채웠다면 상장 자체가 짧은 것이다.
            # 기록해 두지 않으면 다음 실행에서 깊이 부족으로 보고 또 전체를 받는다.
            if df.index.min() > cutoff_ts + pd.Timedelta(days=_DEPTH_TOLERANCE_DAYS):
                _short_history[ticker] = df.index.min().date().isoformat()
            else:
                _short_history.pop(ticker, None)
        elif cached is not None and not cached.empty:
            # 깊이를 채우러 왔다가 API가 실패한 경우. 얕더라도 있던 캐시는 그대로 쓴다 —
            # 여기서 버리면 어제까지 잘 나오던 종목이 일시적 API 장애로 화면에서 사라진다.
            df_out = cached[cached.index >= cutoff_ts]
            if not df_out.empty:
                results[ticker] = df_out

    _save_price_cache(cache)
    _save_exch_cache()
    _save_short_history()

    # 진단: 200일선(SMA200) 계산에 필요한 봉이 모자란 종목이 몇 개인지. 이 값이 크면
    # 스크리너가 그 종목들을 "200일선 아래"로 잘못 떨어뜨리고 있다는 뜻이다.
    thin = sorted(
        ((t, len(df)) for t, df in results.items() if len(df) < _SMA200_BARS),
        key=lambda x: x[1],
    )
    if thin:
        sample = ", ".join(f"{t}({n}봉)" for t, n in thin[:5])
        print(
            f"  ⚠ 200봉 미만 {len(thin)}/{len(results)}개 (최소 {thin[0][1]}봉) — 예: {sample}",
            flush=True,
        )
    else:
        print(f"  200봉 이상 확보: {len(results)}/{len(results)}개", flush=True)

    return results
