"""
S&P 500 + NASDAQ 100 + Russell 3000 합산 유니버스.
Russell 3000 (Vanguard VTHR API)은 중소형주 커버리지 확장용.
VTHR 수집 실패 시 S&P 400 + S&P 600 으로 폴백 (S&P 500·NASDAQ100은 항상 시도).
"""
from __future__ import annotations

import io
import re
import time
import zipfile

import FinanceDataReader as fdr
import pandas as pd
import requests

VANGUARD_VTHR_BASE = (
    "https://investor.vanguard.com/investment-products/etfs/profile/api/VTHR/portfolio-holding/stock"
)

_KIS_MASTER_BASE = "https://new.real.download.dws.co.kr/common/master/"
_KIS_MASTER_FILES = {"NAS": "nasmst.cod", "NYS": "nysmst.cod", "AMS": "amsmst.cod"}
_KR_RE = re.compile(r"[가-힣]")

# Yahoo Finance uses hyphens for share class suffixes (BRK-B, BF-B).
_TICKER_CORRECTIONS: dict[str, str] = {
    "BRKB": "BRK-B",
    "BFB": "BF-B",
}

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.ishares.com/us/",
}


def _normalize_ticker(t: str) -> str:
    if not isinstance(t, str):
        return ""
    t = t.strip()
    if t in _TICKER_CORRECTIONS:
        return _TICKER_CORRECTIONS[t]
    return t.replace(".", "-")


def _read_html(url: str) -> list[pd.DataFrame]:
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    resp.raise_for_status()
    return pd.read_html(io.StringIO(resp.text))


def _fetch_vthr_holdings() -> pd.DataFrame:
    """Vanguard VTHR (Russell 3000 ETF) API에서 미국 주식 티커 목록 반환."""
    all_entities: list[dict] = []
    start = 1
    total_size: int | None = None
    while True:
        resp = requests.get(
            f"{VANGUARD_VTHR_BASE}?start={start}&count=500",
            headers=_HEADERS,
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
        if total_size is None:
            total_size = data.get("size", 0)
        entities = data.get("fund", {}).get("entity", [])
        if not entities:
            break
        all_entities.extend(entities)
        if len(all_entities) >= total_size:
            break
        start += 500
        time.sleep(0.2)

    result = pd.DataFrame({
        "ticker": [str(e.get("ticker", "")).strip() for e in all_entities],
        "name": [e.get("longName", "") for e in all_entities],
        "sector": None,
    })
    result["ticker"] = result["ticker"].str.replace(".", "-", regex=False)
    result = result[result["ticker"].notna() & ~result["ticker"].isin(["-", "", "nan"])]
    return result


def _fetch_sp_index(wiki_url: str, membership_label: str) -> pd.DataFrame:
    """Wikipedia S&P 지수 구성종목 페이지에서 티커·이름·섹터 추출."""
    tables = _read_html(wiki_url)
    for t in tables:
        ticker_col = next(
            (c for c in t.columns if "symbol" in str(c).lower() or "ticker" in str(c).lower()), None
        )
        name_col = next(
            (c for c in t.columns if "security" in str(c).lower() or "company" in str(c).lower()), None
        )
        sector_col = next((c for c in t.columns if "sector" in str(c).lower()), None)
        if ticker_col and name_col:
            return pd.DataFrame({
                "ticker": t[ticker_col].astype(str),
                "name": t[name_col].astype(str),
                "sector": t[sector_col].astype(str) if sector_col else None,
                "index_membership": membership_label,
            })
    raise ValueError(f"{wiki_url} 에서 구성종목 테이블을 찾을 수 없음")


def get_us_korean_names() -> dict[str, str]:
    """KIS 해외주식 마스터 파일에서 티커 → 한글 종목명 매핑 반환.

    실패 시 빈 dict 반환 — 한글명 없어도 파이프라인 정상 작동.
    레이아웃: 단축코드(6) + 표준코드(12) + 한글명(40 bytes EUC-KR) + 영문명(80) + ...
    """
    result: dict[str, str] = {}
    for exchange, filename in _KIS_MASTER_FILES.items():
        url = f"{_KIS_MASTER_BASE}{filename}.zip"
        try:
            resp = requests.get(url, timeout=60)
            resp.raise_for_status()
            with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                actual = zf.namelist()[0]
                raw = zf.read(actual)
            count = 0
            for line in raw.split(b"\n"):
                line = line.rstrip(b"\r")
                if not line:
                    continue
                try:
                    parts = line.decode("euc-kr", errors="replace").split("\t")
                    if len(parts) < 7:
                        continue
                    ticker = parts[4].strip()
                    kr_name = parts[6].strip()
                except Exception:
                    continue
                if not ticker or not _KR_RE.search(kr_name):
                    continue
                if not re.match(r"^[A-Z]{1,5}(-[A-Z])?$", ticker):
                    continue
                result[ticker] = kr_name
                count += 1
            print(f"  KIS 마스터 [{exchange}] {filename}: {count}개 한글명", flush=True)
        except Exception as exc:
            print(f"  KIS 마스터 [{exchange}] 건너뜀: {exc}", flush=True)
    return result


def get_us_universe() -> pd.DataFrame:
    """S&P 500 + NASDAQ 100 + Russell 3000 합산 유니버스를 반환."""
    parts: list[pd.DataFrame] = []

    # 1. S&P 500 (FinanceDataReader – sector 정보 풍부하여 앞에 배치)
    try:
        sp500 = fdr.StockListing("S&P500")[["Symbol", "Name", "Sector"]].rename(
            columns={"Symbol": "ticker", "Name": "name", "Sector": "sector"}
        )
        sp500["index_membership"] = "S&P500"
        parts.append(sp500)
        print(f"  S&P 500: {len(sp500)}개")
    except Exception as e:
        print(f"  S&P 500 실패: {e}")

    # 2. NASDAQ 100 (Wikipedia)
    try:
        ndx = _fetch_sp_index("https://en.wikipedia.org/wiki/Nasdaq-100", "NASDAQ100")
        parts.append(ndx)
        print(f"  NASDAQ 100: {len(ndx)}개")
    except Exception as e:
        print(f"  NASDAQ 100 실패: {e}")

    # 3. Russell 3000 (Vanguard VTHR) – 중소형주 커버리지 확장
    try:
        vthr = _fetch_vthr_holdings()
        vthr["index_membership"] = "Russell3000"
        parts.append(vthr)
        print(f"  Russell 3000 (Vanguard VTHR): {len(vthr)}개")
    except Exception as e:
        print(f"  Russell 3000 수집 실패 ({e})")
        # 폴백: S&P 400 + S&P 600으로 중소형주 커버리지 확보
        for label, url in [
            ("S&P400", "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies"),
            ("S&P600", "https://en.wikipedia.org/wiki/List_of_S%26P_600_companies"),
        ]:
            try:
                df = _fetch_sp_index(url, label)
                parts.append(df)
                print(f"    {label}: {len(df)}개")
            except Exception as ex:
                print(f"    {label} 실패: {ex}")

    if not parts:
        raise RuntimeError("유니버스 수집 완전 실패")

    universe = pd.concat(parts, ignore_index=True)
    universe["ticker"] = universe["ticker"].map(_normalize_ticker)
    universe = universe[universe["ticker"].str.len() > 0]
    # S&P500 → NASDAQ100 → Russell3000 순으로 중복 시 앞쪽 우선 (sector 정보 보존)
    universe = universe.drop_duplicates(subset="ticker", keep="first")
    print(f"  → 합산 유니버스: {len(universe)}개 (중복 제거 후)")

    kr_names = get_us_korean_names()
    universe["name_kr"] = universe["ticker"].map(kr_names).fillna("")
    matched = (universe["name_kr"] != "").sum()
    print(f"  → 한글명 매핑: {matched}개 / {len(universe)}개", flush=True)

    return universe[["ticker", "name", "name_kr", "sector", "index_membership"]]
