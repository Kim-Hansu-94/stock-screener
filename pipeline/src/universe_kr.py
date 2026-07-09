from __future__ import annotations

import time
from pathlib import Path

import FinanceDataReader as fdr
import pandas as pd

# KRX(data.krx.co.kr)는 GitHub 러너 IP를 간헐적으로 차단한다(Akamai "Access Denied",
# 2026-07-09 실측 — 같은 코드가 러너 IP에 따라 성공/실패). 그래서 다운로드에 성공한
# 날의 유니버스를 파일로 남겨두고(워크플로가 Actions cache로 날짜 간 이월),
# 재시도 후에도 실패하면 최근 성공본으로 대체해 파이프라인 전체가 죽지 않게 한다.
_CACHE_PATH = Path(__file__).resolve().parent.parent / ".kr_universe_cache.pkl"
_FETCH_ATTEMPTS = 3
_RETRY_WAIT_SEC = 40


def _fetch_kr_universe(min_market_cap: float) -> pd.DataFrame:
    listing = fdr.StockListing("KRX")[["Code", "Name", "Market", "Marcap"]]
    # KRX-DESC의 "Sector"는 KOSPI 종목엔 전부 NaN이고 KOSDAQ 시장구분(벤처/우량기업부)만
    # 담긴다. 실제 업종 분류는 "Industry"(예: "반도체 제조업")에 있으므로 이를 섹터로 쓴다.
    desc = fdr.StockListing("KRX-DESC")[["Code", "Industry", "Sector"]]
    desc["sector"] = desc["Industry"].fillna(desc["Sector"])

    universe = listing.merge(desc[["Code", "sector"]], on="Code", how="left")
    universe = universe.rename(columns={
        "Code": "ticker",
        "Name": "name",
        "Market": "index_membership",
        "Marcap": "market_cap",
    })
    universe["meets_cap_threshold"] = universe["market_cap"] >= min_market_cap
    result = universe[
        ["ticker", "name", "sector", "index_membership", "market_cap", "meets_cap_threshold"]
    ].copy()
    result["meets_cap_threshold"] = result["meets_cap_threshold"].astype(object)
    return result


def get_kr_universe(min_market_cap: float) -> pd.DataFrame:
    last_error: Exception | None = None
    for attempt in range(1, _FETCH_ATTEMPTS + 1):
        try:
            result = _fetch_kr_universe(min_market_cap)
            result.to_pickle(_CACHE_PATH)
            return result
        except Exception as exc:  # noqa: BLE001 - fdr는 차단/파싱 실패를 다양한 예외로 던진다
            last_error = exc
            print(f"  KRX 유니버스 다운로드 실패 ({attempt}/{_FETCH_ATTEMPTS}): {exc}", flush=True)
            if attempt < _FETCH_ATTEMPTS:
                time.sleep(_RETRY_WAIT_SEC)

    if _CACHE_PATH.exists():
        cached = pd.read_pickle(_CACHE_PATH)
        cached["meets_cap_threshold"] = (cached["market_cap"] >= min_market_cap).astype(object)
        print(f"  KRX 차단 지속 → 최근 성공본 유니버스({len(cached)}종목)로 대체", flush=True)
        return cached
    raise last_error
