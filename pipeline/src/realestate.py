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
import urllib.parse
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import date

import requests

_BASE = "https://apis.data.go.kr/1613000"

# 국토부 아파트 매매는 두 종류다 — "실거래가 자료"(AptTrade)와 "실거래 상세
# 자료"(AptTradeDev). 활용신청은 각각 따로라, 신청 안 한 쪽을 부르면 게이트웨이가
# 403을 준다(resultCode가 아니라 HTTP 403이다). 어느 쪽을 신청했는지 사용자가
# 알기 어려우므로 순서대로 시도하고, 통하는 것을 기억해 두 번 부르지 않는다.
_TRADE_URLS = (
    f"{_BASE}/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev",
    f"{_BASE}/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade",
)
_RENT_URLS = (
    f"{_BASE}/RTMSDataSvcAptRent/getRTMSDataSvcAptRent",
)
_NUM_OF_ROWS = 1000
_TIMEOUT = 20
# 연속 실패가 이만큼 쌓이면 공통 원인(키·신청·엔드포인트)으로 보고 중단한다.
_ABORT_AFTER = 20
# 기본 UA로 막히는 공공 API 게이트웨이가 있어 명시한다.
_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; stock-screener/1.0)"}

# 이번 실행에서 실제로 통한 엔드포인트. 지역·월마다 후보를 다시 훑지 않기 위한 캐시.
_WORKING: dict[str, str] = {}

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


def normalize_service_key(key: str) -> str:
    """data.go.kr 인증키를 원본 형태로 되돌린다.

    data.go.kr은 같은 키를 Encoding(`abc%2Bdef`)과 Decoding(`abc+def`) 두 형태로
    주는데, 화면에 따라 한쪽만 보이기도 한다. requests가 파라미터를 다시 인코딩하므로
    Encoding 키를 그대로 넘기면 `%2B`가 `%252B`로 이중 인코딩돼 인증이 깨진다.
    그때 서버는 "SERVICE KEY IS NOT REGISTERED"를 돌려줘서, 키가 잘못된 줄 알고
    재발급받는 헛수고를 하게 된다.

    발급 키는 base64 계열(A-Za-z0-9+/=)이라 원본에는 `%`가 나올 수 없다. 그래서
    `%`가 보이면 인코딩된 형태로 보고 한 번 풀어준다 — 어느 쪽을 넣어도 동작한다.
    """
    return urllib.parse.unquote(key) if "%" in key else key


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


def _fetch_one(url: str, service_key: str, region_code: str, ym: str) -> list[ET.Element]:
    resp = requests.get(
        url,
        params={
            "serviceKey": normalize_service_key(service_key),
            "LAWD_CD": region_code,
            "DEAL_YMD": ym,
            "numOfRows": _NUM_OF_ROWS,
            "pageNo": 1,
        },
        headers=_HEADERS,
        timeout=_TIMEOUT,
    )
    if not resp.ok:
        # raise_for_status()는 상태 코드만 알려준다. 403 본문에 "요청하신 서비스는
        # 이용할 수 없습니다" 같은 실제 사유가 들어 있어, 그걸 봐야 신청 문제인지
        # 키 문제인지 구분된다.
        body = " ".join(resp.text.split())[:200]
        raise RuntimeError(f"HTTP {resp.status_code} ({url.rsplit('/', 1)[-1]}): {body}")

    root = ET.fromstring(resp.text)

    # 정상 응답이라도 본문에 에러코드가 실려 온다(HTTP 200 + resultCode != 00).
    # 키 미승인·트래픽 초과가 여기로 떨어지므로 조용히 빈 목록으로 넘기면 안 된다.
    code = root.findtext(".//resultCode") or root.findtext(".//returnReasonCode")
    if code and code not in ("00", "000"):
        msg = root.findtext(".//resultMsg") or root.findtext(".//returnAuthMsg") or ""
        raise RuntimeError(f"API 오류 {code}: {msg}")

    return root.findall(".//item")


def _fetch(kind: str, urls: tuple[str, ...], service_key: str, region_code: str, ym: str) -> list[ET.Element]:
    """한 지역·한 달치 원본 건별 목록.

    후보 엔드포인트를 순서대로 시도한다. 한 번 통한 뒤로는 그것만 쓴다 —
    2,772번 호출하는 작업이라 매번 후보를 훑으면 시간이 배로 든다.
    """
    known = _WORKING.get(kind)
    if known:
        return _fetch_one(known, service_key, region_code, ym)

    last: Exception | None = None
    for url in urls:
        try:
            items = _fetch_one(url, service_key, region_code, ym)
        except Exception as exc:  # noqa: BLE001
            last = exc
            continue
        _WORKING[kind] = url
        print(f"  사용 엔드포인트({kind}): {url.rsplit('/', 1)[-1]}", flush=True)
        return items

    raise last if last else RuntimeError("호출 후보 없음")


def collect_region_month(
    service_key: str, region_code: str, region_name: str, year: int, month: int
) -> RegionMonth:
    """한 지역·한 달의 매매·전월세를 모아 집계 대상으로 만든다."""
    agg = RegionMonth(region_code, region_name, date(year, month, 1))
    ym = f"{year}{month:02d}"

    for item in _fetch("매매", _TRADE_URLS, service_key, region_code, ym):
        if _text(item, "canceled") == "O":  # 해제된 계약
            continue
        amount = _number(_text(item, "amount"))
        if amount is None:
            continue
        agg.deal_prices.append(amount)
        agg.deal_areas.append(_number(_text(item, "area")) or 0.0)

    for item in _fetch("전월세", _RENT_URLS, service_key, region_code, ym):
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
    consecutive_failures = 0
    aborted = False

    for code, name in regions.items():
        if aborted:
            break
        got_any = False
        had_error = False
        for year, month in months:
            try:
                agg = collect_region_month(key, code, name, year, month)
            except Exception as exc:  # noqa: BLE001
                had_error = True
                consecutive_failures += 1
                errors.append(f"{name}({code}) {year}-{month:02d}: {exc}")
                # 키·신청 문제면 2,772건이 전부 같은 이유로 실패한다. 첫 실행이
                # 그렇게 30분을 헛돌았다 — 연속으로 계속 깨지면 원인이 개별
                # 지역이 아니라 공통이므로 일찍 멈추고 사유를 보여준다.
                if consecutive_failures >= _ABORT_AFTER:
                    aborted = True
                    break
                continue
            consecutive_failures = 0
            if agg.deal_prices or agg.jeonse_deposits or agg.monthly_rent_count:
                got_any = True
                rows.append(agg.to_row())
        # 호출이 실패한 지역을 "0건"으로도 세면 안 된다 — 잘못된 지역코드를 찾으려고
        # 보는 목록인데, 일시적 장애가 섞이면 멀쩡한 코드를 고치게 된다.
        if not got_any and not had_error:
            empty.append(f"{name}({code})")

    return rows, {"empty": empty, "error": errors, "aborted": ["연속 실패로 중단"] if aborted else []}
