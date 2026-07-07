"""
추천 종목의 재무 지표(PER·PBR·EPS·ROE·배당수익률·매출성장률·순이익률) 수집.

yfinance Ticker.get_info()를 사용하므로 종목당 1회 API 호출이 발생한다.
전체 유니버스가 아닌 화면에 노출되는 종목(스크리닝 통과 + 패턴 매칭)만
대상으로 하여 호출 수를 수십 건 수준으로 유지한다.
"""
from __future__ import annotations

from datetime import date

import yfinance as yf

# 한국 종목은 야후 심볼이 거래소 접미사를 요구한다 (KOSPI=.KS, KOSDAQ=.KQ).
# 유니버스에 거래소 구분이 없으므로 .KS 먼저 시도하고 실패 시 .KQ로 폴백.
_KR_SUFFIXES = (".KS", ".KQ")

# 소수(fraction)로 내려오는 필드 → % 로 변환해 저장.
# dividendYield는 yfinance 0.2.54부터 이미 % 단위라 변환하지 않는다.
_FRACTION_FIELDS = {"returnOnEquity": "roe", "revenueGrowth": "revenue_growth", "profitMargins": "profit_margin"}
_RAW_FIELDS = {"trailingPE": "per", "priceToBook": "pbr", "trailingEps": "eps", "dividendYield": "dividend_yield"}


def _to_float(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result else None  # NaN 제거


def _extract(info: dict) -> dict | None:
    """info dict에서 재무 지표를 추출. 유효한 값이 하나도 없으면 None."""
    row: dict = {}
    for key, column in _RAW_FIELDS.items():
        row[column] = _to_float(info.get(key))
    for key, column in _FRACTION_FIELDS.items():
        value = _to_float(info.get(key))
        row[column] = value * 100 if value is not None else None
    if all(v is None for v in row.values()):
        return None
    return row


def _fetch_info(symbol: str) -> dict:
    try:
        return yf.Ticker(symbol).get_info() or {}
    except Exception:
        return {}


def get_fundamentals(tickers: list[str], market: str, as_of: date) -> list[dict]:
    """티커 목록의 재무 지표 행을 반환. 데이터가 없는 종목은 건너뜀."""
    rows: list[dict] = []
    seen: set[str] = set()
    for ticker in tickers:
        if ticker in seen:
            continue
        seen.add(ticker)
        symbols = [ticker] if market == "US" else [f"{ticker}{s}" for s in _KR_SUFFIXES]
        for symbol in symbols:
            extracted = _extract(_fetch_info(symbol))
            if extracted is not None:
                rows.append({
                    "ticker": ticker,
                    "market": market,
                    **extracted,
                    "updated_at": as_of.isoformat(),
                })
                break
    return rows
