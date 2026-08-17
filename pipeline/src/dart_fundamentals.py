"""국내 종목 실적 수집 — DART(전자공시시스템) Open API.

Yahoo Finance는 국내 소형주 손익계산서를 잘 못 갖고 있어(커버리지 갭) 실적
배지가 계속 "데이터 없음"으로 남는 종목이 많았다. DART는 국내 상장사가
의무적으로 제출하는 공시 원본이라 커버리지가 사실상 전수에 가깝다 — 그래서
국내 종목은 이 모듈로 완전히 교체하고, 미국 종목은 그대로 fundamentals.py의
yfinance 경로를 쓴다.

단일회사 주요계정(fnlttSinglAcnt.json) 하나면 당기·전기·전전기 3개년
매출액·영업이익·당기순이익이 한 번에 나와서, 종목당 API 호출 1번으로 끝난다
(Yahoo 경로는 재무제표+info 해서 2번, 게다가 스크레이핑성 접근이라 레이트리밋도
훨씬 빡빡했다). PER·PBR은 DART가 시가 데이터를 안 갖고 있어(공시 전용) 여기선
채우지 않는다 — 그 두 필드는 참고용 부가 정보라 fundamentals.py 판정 로직에는
영향 없다.
"""

from __future__ import annotations

import io
import os
import xml.etree.ElementTree as ET
import zipfile

import requests

_BASE = "https://opendart.fss.or.kr/api"
_REPORT_CODE = "11011"  # 사업보고서(연간)
_REVENUE_ACCOUNT = "매출액"
_OPERATING_INCOME_ACCOUNT = "영업이익"
_NET_INCOME_ACCOUNT = "당기순이익"

# 프로세스 내 1회만 로드 — 상장사 고유번호 매핑은 종목당 API가 아니라 통짜
# ZIP 1개(전체 등록법인 약 10만 건)라, 매 실행마다 새로 받아도 수 초 이내라
# KR 유니버스 캐시처럼 GitHub Actions 캐시를 따로 둘 필요는 없다.
_corp_code_cache: dict[str, str] | None = None  # {stock_code: corp_code}


def _api_key() -> str | None:
    return os.environ.get("DART_API_KEY") or None


def _load_corp_codes(api_key: str) -> dict[str, str]:
    global _corp_code_cache
    if _corp_code_cache is not None:
        return _corp_code_cache

    resp = requests.get(f"{_BASE}/corpCode.xml", params={"crtfc_key": api_key}, timeout=30)
    resp.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        xml_bytes = zf.read("CORPCODE.xml")

    mapping: dict[str, str] = {}
    for elem in ET.fromstring(xml_bytes).findall("list"):
        stock_code = (elem.findtext("stock_code") or "").strip()
        corp_code = (elem.findtext("corp_code") or "").strip()
        if stock_code and corp_code:
            mapping[stock_code] = corp_code

    _corp_code_cache = mapping
    return mapping


def _amount(row: dict | None, key: str) -> float | None:
    if row is None:
        return None
    raw = row.get(key)
    if not raw:
        return None
    try:
        return float(str(raw).replace(",", ""))
    except ValueError:
        return None


def _pick_account(rows: list[dict], account_name: str) -> dict | None:
    """같은 계정명이 연결(CFS)·별도(OFS) 두 벌로 올 수 있어 연결 재무제표를 우선한다."""
    matches = [r for r in rows if r.get("account_nm") == account_name]
    if not matches:
        return None
    cfs = next((r for r in matches if r.get("fs_div") == "CFS"), None)
    return cfs or matches[0]


def _parse_year(rows: list[dict], bsns_year: int) -> dict | None:
    revenue_row = _pick_account(rows, _REVENUE_ACCOUNT)
    operating_row = _pick_account(rows, _OPERATING_INCOME_ACCOUNT)
    profit_row = _pick_account(rows, _NET_INCOME_ACCOUNT)
    if revenue_row is None and profit_row is None:
        return None

    # 당기(thstrm) vs 전전기(bfefrmtrm) — 한 번의 조회로 2년 전과 비교해
    # Yahoo 경로("가능한 한 긴 구간의 변화를 본다")의 취지와 맞춘다.
    return {
        "fiscal_year_latest": bsns_year,
        "fiscal_year_prior": bsns_year - 2,
        "revenue_latest": _amount(revenue_row, "thstrm_amount"),
        "revenue_prior": _amount(revenue_row, "bfefrmtrm_amount"),
        "operating_income_latest": _amount(operating_row, "thstrm_amount"),
        "operating_income_prior": _amount(operating_row, "bfefrmtrm_amount"),
        "net_income_latest": _amount(profit_row, "thstrm_amount"),
        "net_income_prior": _amount(profit_row, "bfefrmtrm_amount"),
        "eps_latest": None,
        "eps_prior": None,
        "per": None,
        "pbr": None,
    }


def _fetch_year(corp_code: str, api_key: str, bsns_year: int) -> dict | None:
    resp = requests.get(
        f"{_BASE}/fnlttSinglAcnt.json",
        params={
            "crtfc_key": api_key,
            "corp_code": corp_code,
            "bsns_year": str(bsns_year),
            "reprt_code": _REPORT_CODE,
        },
        timeout=15,
    )
    resp.raise_for_status()
    body = resp.json()
    if body.get("status") != "000":
        return None
    return _parse_year(body.get("list") or [], bsns_year)


def extract(ticker: str, latest_year: int) -> dict | None:
    """fundamentals.py의 _extract()와 같은 모양의 dict를 반환해 저장 로직을 그대로 쓴다.

    latest_year 사업보고서가 아직 제출 전이면(연초~3월, 제출기한은 회계연도
    종료 후 3개월) 한 해 앞으로 물러나 재시도한다.
    """
    api_key = _api_key()
    if not api_key:
        return None

    corp_codes = _load_corp_codes(api_key)
    corp_code = corp_codes.get(ticker)
    if not corp_code:
        return None

    for year in (latest_year, latest_year - 1):
        result = _fetch_year(corp_code, api_key, year)
        if result is not None:
            return result
    return None
