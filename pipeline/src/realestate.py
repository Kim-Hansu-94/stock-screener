"""부동산 실거래 동향 수집 — 국토교통부 실거래가 Open API.

주식 파이프라인과 분리해서 돌린다(.github/workflows/realestate.yml). 실거래는
신고 기한이 30일이라 매일 볼 이유가 없고, 무엇보다 부동산 수집이 실패했다고
주식 스크리닝까지 죽으면 안 된다.

건별 원본은 저장하지 않고 시군구 × 월로 집계해 realestate_monthly에 넣는다
(이유는 supabase/realestate.sql 주석 참고).

⚠️ 지역코드가 틀리면 API가 에러가 아니라 **빈 결과**를 돌려준다. 조용히 비는 걸
막으려고 0건 지역을 모아서 로그에 남긴다 — 첫 실행 로그로 lawd_codes.py를 고칠 것.
"""

from __future__ import annotations

import os
import statistics
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import date

import requests

_TRADE_URL = "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev"
_RENT_URL = "https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent"
_NUM_OF_ROWS = 1000
_TIMEOUT = 20

# 응답 태그명이 API 개편마다 조금씩 달라져 왔다(dealAmount ↔ 거래금액 등).
# 후보를 순서대로 시도하고, 하나도 못 찾으면 그 건은 건너뛰되 사유를 센다.
_TAGS = {
    "amount": ("dealAmount", "거래금액"),
    "area": ("excluUseAr", "전용면적"),
    "deposit": ("deposit", "보증금액"),
    "rent": ("monthlyRent", "월세금액"),
    # 해제된 거래. 'O'면 취소된 계약이라 집계에서 빼야 한다 — 안 빼면 없던 거래가
    # 시세로 잡힌다.
    "canceled": ("cdealType", "해제여부"),
}


def _text(item: ET.Element, key: str) -> str | None:
    for tag in _TAGS[key]:
        node = item.find(tag)
        if node is not None and node.text and node.text.strip():
            return node.text.strip()
    return None


def _number(raw: str | None) -> float | None:
    """'123,456' → 123456.0. 국토부는 금액을 만원 단위 콤마 문자열로 준다."""
    if raw is None:
        return None
    cleaned = raw.replace(",", "").strip()
    try:
        return float(cleaned)
    except ValueError:
        return None


@dataclass
class RegionMonth:
    """한 지역·한 달의 집계 결과."""

    region_code: str
    region_name: str
    month: date
    deal_prices: list[float] = field(default_factory=list)
    deal_areas: list[float] = field(default_factory=list)
    jeonse_deposits: list[float] = field(default_factory=list)
    monthly_rent_count: int = 0

    def to_row(self) -> dict:
        price_avg = _mean(self.deal_prices)
        deposit_avg = _mean(self.jeonse_deposits)
        # ㎡당 단가는 "건별 단가의 평균"으로 낸다. 총액평균 ÷ 면적평균으로 내면
        # 큰 평수 몇 건이 분모를 끌어올려 단가가 실제보다 낮게 나온다.
        per_area = [
            price / area
            for price, area in zip(self.deal_prices, self.deal_areas)
            if area and area > 0
        ]
        return {
            "region_code": self.region_code,
            "region_name": self.region_name,
            "month": self.month.isoformat(),
            "deal_count": len(self.deal_prices),
            "price_avg": price_avg,
            "price_median": _median(self.deal_prices),
            "price_per_area_avg": _mean(per_area),
            "jeonse_count": len(self.jeonse_deposits),
            "deposit_avg": deposit_avg,
            "deposit_median": _median(self.jeonse_deposits),
            "monthly_rent_count": self.monthly_rent_count,
            "jeonse_ratio": (deposit_avg / price_avg) if price_avg and deposit_avg else None,
            "gap_avg": (price_avg - deposit_avg) if price_avg and deposit_avg else None,
        }


def _mean(values: list[float]) -> float | None:
    return round(statistics.fmean(values), 1) if values else None


def _median(values: list[float]) -> float | None:
    return round(statistics.median(values), 1) if values else None


def _fetch(url: str, service_key: str, region_code: str, ym: str) -> list[ET.Element]:
    """한 지역·한 달치 원본 건별 목록. 실패는 호출부가 세도록 예외로 올린다."""
    resp = requests.get(
        url,
        params={
            "serviceKey": service_key,
            "LAWD_CD": region_code,
            "DEAL_YMD": ym,
            "numOfRows": _NUM_OF_ROWS,
            "pageNo": 1,
        },
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    root = ET.fromstring(resp.text)

    # 정상 응답이라도 본문에 에러코드가 실려 온다(HTTP 200 + resultCode != 00).
    # 키 미승인·트래픽 초과가 여기로 떨어지므로 조용히 빈 목록으로 넘기면 안 된다.
    code = root.findtext(".//resultCode") or root.findtext(".//returnReasonCode")
    if code and code not in ("00", "000"):
        msg = root.findtext(".//resultMsg") or root.findtext(".//returnAuthMsg") or ""
        raise RuntimeError(f"API 오류 {code}: {msg}")

    return root.findall(".//item")


def collect_region_month(
    service_key: str, region_code: str, region_name: str, year: int, month: int
) -> RegionMonth:
    """한 지역·한 달의 매매·전월세를 모아 집계 대상으로 만든다."""
    agg = RegionMonth(region_code, region_name, date(year, month, 1))
    ym = f"{year}{month:02d}"

    for item in _fetch(_TRADE_URL, service_key, region_code, ym):
        if _text(item, "canceled") == "O":  # 해제된 계약
            continue
        amount = _number(_text(item, "amount"))
        if amount is None:
            continue
        agg.deal_prices.append(amount)
        agg.deal_areas.append(_number(_text(item, "area")) or 0.0)

    for item in _fetch(_RENT_URL, service_key, region_code, ym):
        deposit = _number(_text(item, "deposit"))
        rent = _number(_text(item, "rent")) or 0.0
        if deposit is None:
            continue
        if rent > 0:
            agg.monthly_rent_count += 1
        else:
            agg.jeonse_deposits.append(deposit)

    return agg


def collect(
    regions: dict[str, str], months: list[tuple[int, int]], service_key: str | None = None
) -> tuple[list[dict], dict[str, list[str]]]:
    """지역 × 월을 훑어 집계 행과 진단 정보를 돌려준다.

    진단은 두 갈래로 나눈다 — 지역코드가 틀려서 계속 0건인 것("empty")과
    호출 자체가 실패한 것("error")은 대응이 완전히 다르기 때문이다.
    """
    key = service_key or os.getenv("MOLIT_API_KEY")
    if not key:
        print("MOLIT_API_KEY 미설정 → 부동산 수집 건너뜀", flush=True)
        return [], {}

    rows: list[dict] = []
    empty: list[str] = []
    errors: list[str] = []

    for code, name in regions.items():
        got_any = False
        had_error = False
        for year, month in months:
            try:
                agg = collect_region_month(key, code, name, year, month)
            except Exception as exc:  # noqa: BLE001
                had_error = True
                errors.append(f"{name}({code}) {year}-{month:02d}: {exc}")
                continue
            if agg.deal_prices or agg.jeonse_deposits or agg.monthly_rent_count:
                got_any = True
                rows.append(agg.to_row())
        # 호출이 실패한 지역을 "0건"으로도 세면 안 된다 — 잘못된 지역코드를 찾으려고
        # 보는 목록인데, 일시적 장애가 섞이면 멀쩡한 코드를 고치게 된다.
        if not got_any and not had_error:
            empty.append(f"{name}({code})")

    return rows, {"empty": empty, "error": errors}
