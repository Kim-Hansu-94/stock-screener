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
from collections.abc import Callable
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
# 프로브는 1,000번을 두드리므로 한 건이 오래 붙잡고 있으면 안 된다. 정상 응답은
# 1~2초라 8초면 넉넉하고, 막힌 상태는 빨리 드러난다.
_PROBE_TIMEOUT = 8
_PROBE_ABORT_TIMEOUTS = 10

# 전용면적 구간. 부동산원·KB가 쓰는 관례를 따랐다 — 60㎡ 이하(소형),
# 60~85㎡(국민주택규모, 거래가 가장 많다), 85~135㎡(중대형), 135㎡ 초과(대형).
# 소형과 대형은 사이클이 어긋나게 움직여서(상승 초기엔 중소형이 먼저 뛴다) 한데
# 묶어 평균 내면 두 흐름이 상쇄돼 "움직임 없음"으로 보인다.
#
# 'ALL'은 구 전체 합계다. 기본 화면은 이 한 줄만 쓰고, 펼칠 때 구간별을 보여준다.
AREA_BANDS: tuple[tuple[str, float, float], ...] = (
    ("~60", 0.0, 60.0),
    ("60~85", 60.0, 85.0),
    ("85~135", 85.0, 135.0),
    ("135~", 135.0, float("inf")),
)
ALL_BAND = "ALL"


def band_of(area: float) -> str | None:
    """전용면적 → 구간 이름. 면적을 모르면 None(구간별에서 빠지고 ALL에만 들어간다)."""
    if not area or area <= 0:
        return None
    for name, low, high in AREA_BANDS:
        if low < area <= high:
            return name
    return None
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
    """한 지역·한 달의 원본 거래. 면적을 함께 들고 있어야 구간별로 나눌 수 있다."""

    region_code: str
    region_name: str
    month: date
    # (금액, 전용면적) — 면적을 버리면 나중에 평형별로 쪼갤 수 없다.
    deals: list[tuple[float, float]] = field(default_factory=list)
    jeonse: list[tuple[float, float]] = field(default_factory=list)
    monthly_rents: list[float] = field(default_factory=list)  # 면적만 (건수용)

    def has_data(self) -> bool:
        return bool(self.deals or self.jeonse or self.monthly_rents)

    def to_rows(self) -> list[dict]:
        """구 전체(ALL) + 면적 구간별 행. 데이터가 없는 구간은 만들지 않는다."""
        rows = [self._row(ALL_BAND, self.deals, self.jeonse, self.monthly_rents)]
        for name, _, _ in AREA_BANDS:
            deals = [d for d in self.deals if band_of(d[1]) == name]
            jeonse = [j for j in self.jeonse if band_of(j[1]) == name]
            rents = [a for a in self.monthly_rents if band_of(a) == name]
            if deals or jeonse or rents:
                rows.append(self._row(name, deals, jeonse, rents))
        return rows

    def _row(
        self,
        band: str,
        deals: list[tuple[float, float]],
        jeonse: list[tuple[float, float]],
        rents: list[float],
    ) -> dict:
        prices = [price for price, _ in deals]
        deposits = [deposit for deposit, _ in jeonse]
        price_avg = _mean(prices)
        deposit_avg = _mean(deposits)
        # ㎡당 단가는 "건별 단가의 평균"으로 낸다. 총액평균 ÷ 면적평균으로 내면
        # 큰 평수 몇 건이 분모를 끌어올려 단가가 실제보다 낮게 나온다.
        per_area = [price / area for price, area in deals if area and area > 0]
        return {
            "region_code": self.region_code,
            "region_name": self.region_name,
            "month": self.month.isoformat(),
            "area_band": band,
            "deal_count": len(prices),
            "price_avg": price_avg,
            "price_median": _median(prices),
            "price_per_area_avg": _mean(per_area),
            "jeonse_count": len(deposits),
            "deposit_avg": deposit_avg,
            "deposit_median": _median(deposits),
            "monthly_rent_count": len(rents),
            "jeonse_ratio": (deposit_avg / price_avg) if price_avg and deposit_avg else None,
            "gap_avg": (price_avg - deposit_avg) if price_avg and deposit_avg else None,
        }


def _mean(values: list[float]) -> float | None:
    return round(statistics.fmean(values), 1) if values else None


def _median(values: list[float]) -> float | None:
    return round(statistics.median(values), 1) if values else None


def _fetch_one(url: str, service_key: str, region_code: str, ym: str) -> list[ET.Element]:
    # 5,544번 호출하는 동안 26건이 Read timeout으로 빠졌다. 한 번만 다시 시도해도
    # 대부분 메워진다 — 놓친 달은 다음 주간 실행이 자동으로 채워주지 않는다
    # (최근 3개월만 훑기 때문에).
    try:
        return _fetch_once(url, service_key, region_code, ym)
    except requests.Timeout:
        return _fetch_once(url, service_key, region_code, ym)


def _fetch_once(
    url: str, service_key: str, region_code: str, ym: str, timeout: int = _TIMEOUT
) -> list[ET.Element]:
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
        timeout=timeout,
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
        agg.deals.append((amount, _number(_text(item, "area")) or 0.0))

    for item in _fetch("전월세", _RENT_URLS, service_key, region_code, ym):
        deposit = _number(_text(item, "deposit"))
        rent = _number(_text(item, "rent")) or 0.0
        if deposit is None:
            continue
        area = _number(_text(item, "area")) or 0.0
        if rent > 0:
            agg.monthly_rents.append(area)
        else:
            agg.jeonse.append((deposit, area))

    return agg


def collect(
    regions: dict[str, str],
    months: list[tuple[int, int]],
    service_key: str | None = None,
    on_rows: "Callable[[list[dict]], None] | None" = None,
) -> tuple[list[dict], dict[str, list[str]]]:
    """지역 × 월을 훑어 집계 행과 진단 정보를 돌려준다.

    on_rows를 주면 지역 하나가 끝날 때마다 그 지역 행을 넘긴다. 36개월 백필은
    5,544번 호출이라 한 시간 넘게 걸리는데, 끝에서 한 번에 저장하면 도중에
    끊길 때 전부 날아간다(실제로 60분 타임아웃에 걸려 그렇게 됐다).

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

    total = len(regions)
    for index, (code, name) in enumerate(regions.items(), start=1):
        if aborted:
            break
        got_any = False
        had_error = False
        region_rows: list[dict] = []
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
            if agg.has_data():
                got_any = True
                region_rows.extend(agg.to_rows())
        if region_rows:
            rows.extend(region_rows)
            if on_rows:
                on_rows(region_rows)

        # 진행 상황을 남긴다. 없으면 한 시간 동안 로그가 한 줄도 안 찍혀
        # 멈춘 것인지 도는 것인지 알 수 없다.
        print(f"  [{index}/{total}] {name} — {len(region_rows)}개월분", flush=True)

        # 호출이 실패한 지역을 "0건"으로도 세면 안 된다 — 잘못된 지역코드를 찾으려고
        # 보는 목록인데, 일시적 장애가 섞이면 멀쩡한 코드를 고치게 된다.
        if not got_any and not had_error:
            empty.append(f"{name}({code})")

    return rows, {"empty": empty, "error": errors, "aborted": ["연속 실패로 중단"] if aborted else []}


def probe_prefix(service_key: str, prefix: str, ym: str) -> list[tuple[str, int]]:
    """시도 코드(앞 2자리)로 시작하는 시군구 코드를 전부 두드려 본다.

    국토부 API는 LAWD_CD가 틀리면 에러가 아니라 빈 결과를 준다. 그래서 거꾸로,
    "데이터가 나오는 코드"를 찾는 탐색에 쓸 수 있다. 행정구역 개편으로 코드가
    바뀐 지역을 기억으로 찍어 맞히려다 또 틀리는 것보다, 한 번 스캔해서 확정하는
    편이 낫다.

    ⚠️ 하루 호출 한도(개발계정 1만 건)를 백필과 같은 날 나눠 쓰면 도중에 응답이
    끊긴다. 실제로 백필 5,544건을 쓴 날 프로브를 돌렸다가 4시간 동안 한 건도
    못 받고 잘렸다. 그래서 여기서는 타임아웃을 짧게 잡고 재시도하지 않는다 —
    막힌 상태라면 빨리 티가 나야 4시간을 버리지 않는다.
    """
    found: list[tuple[str, int]] = []
    # 어느 엔드포인트가 통하는지 먼저 확정해 둔다(프로브 도중에 후보를 번갈아
    # 부르면 한도만 두 배로 쓴다).
    url = _WORKING.get("매매") or _TRADE_URLS[-1]
    timeouts = 0

    for suffix in range(1000):
        code = f"{prefix}{suffix:03d}"
        if suffix and suffix % 100 == 0:
            print(f"    ... {code}까지 확인 (발견 {len(found)}개, 타임아웃 {timeouts}건)", flush=True)
        try:
            items = _fetch_once(url, service_key, code, ym, timeout=_PROBE_TIMEOUT)
        except requests.Timeout:
            timeouts += 1
            # 연속으로 계속 끊기면 한도 소진이나 차단이다. 계속 두드려도 소용없다.
            if timeouts >= _PROBE_ABORT_TIMEOUTS:
                print(
                    f"    타임아웃 {timeouts}건 연속 — 호출 한도 소진이나 차단으로 보고 중단합니다."
                    " 하루 지나고 다시 시도하세요.",
                    flush=True,
                )
                break
            continue
        except Exception:  # noqa: BLE001
            continue
        timeouts = 0
        if items:
            found.append((code, len(items)))
            print(f"    {code}: {len(items)}건", flush=True)
    return found
