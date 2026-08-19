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
import re
import xml.etree.ElementTree as ET
import zipfile

import requests

_BASE = "https://opendart.fss.or.kr/api"
_REPORT_CODE = "11011"  # 사업보고서(연간)
_REVENUE_ACCOUNT = "매출액"
_OPERATING_INCOME_ACCOUNT = "영업이익"
_NET_INCOME_ACCOUNT = "당기순이익"
# 금융지주·은행·증권 등은 주요계정에 "매출액" 대신 "영업수익"으로 잡힌다(DART의
# 잘 알려진 관행 — 일반 기업의 손익계산서 구조를 그대로 강제하지 않기 때문).
# 우선순위대로 시도: 못 찾으면 다음 이름으로. 실제 실행에서 no_key_accounts로
# 떨어진 종목이 몇 개나 이 대체명으로 채워지는지는 다음 로그에서 확인한다.
_REVENUE_ACCOUNT_FALLBACKS = ("영업수익",)
# 증권·보험·금융지주는 "당기순이익" 대신 "당기순이익(손실)"로 잡힌다 — 실제
# no_key_accounts 실패 5건(NH투자증권·삼성증권·BNK금융지주·롯데손보·제주은행,
# 2026-08-19 실행 로그)이 예외 없이 이 표기를 썼다. 매출액 계열 계정은 이
# 업종의 주요계정 응답 자체에 없는 경우가 흔해(대차대조표성 항목 위주) 매출은
# null로 남는 게 정상이고, 순이익만 잡혀도 _parse_year는 통과한다.
_NET_INCOME_ACCOUNT_FALLBACKS = ("당기순이익(손실)",)

# 우선주 종목명 접미사. KRX는 우선주 표시명을 "회사명" + (숫자)? + "우" + "B"?로
# 일관되게 붙인다 — 예: 현대차우, 두산2우B, 삼성전기우. corp_code_not_found로
# 떨어진 종목의 60%가 실제로 이 패턴이었다(2026-08-19 kr_only 실행 로그: 현대차우
# 005385, 두산2우B 000155, 삼성전기우 009155, LG전자우 066575 등). DART의
# corpCode.xml은 법인당 대표 종목코드(보통 보통주) 하나만 매핑하므로 우선주
# 티커로는 애초에 못 찾는다 — 재무제표는 종목(주식 종류)이 아니라 법인 단위이므로,
# 보통주 쪽 corp_code로 조회해 그 값을 그대로 써도 회계적으로 문제없다.
_PREFERRED_SUFFIX = re.compile(r"\d*우B?$")

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


def _strip_preferred_suffix(name: str) -> str | None:
    """우선주 표시명이면 보통주 이름을 돌려주고, 아니면 None.

    빈 문자열이 나오는 경우(이름 전체가 접미사 패턴, 예: "우" 단독)는 우선주
    판정 자체가 신뢰할 수 없으므로 매칭하지 않는다.
    """
    m = _PREFERRED_SUFFIX.search(name)
    if not m or m.start() == 0:
        return None
    return name[: m.start()]


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


def _pick_account_with_fallbacks(rows: list[dict], account_name: str, fallbacks: tuple[str, ...]) -> dict | None:
    """대표 계정명이 없으면 동의어로 재시도한다."""
    picked = _pick_account(rows, account_name)
    if picked is not None:
        return picked
    for alt in fallbacks:
        picked = _pick_account(rows, alt)
        if picked is not None:
            return picked
    return None


def _parse_year(rows: list[dict], bsns_year: int) -> dict | None:
    revenue_row = _pick_account_with_fallbacks(rows, _REVENUE_ACCOUNT, _REVENUE_ACCOUNT_FALLBACKS)
    operating_row = _pick_account(rows, _OPERATING_INCOME_ACCOUNT)
    profit_row = _pick_account_with_fallbacks(rows, _NET_INCOME_ACCOUNT, _NET_INCOME_ACCOUNT_FALLBACKS)
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


def _fetch_year(corp_code: str, api_key: str, bsns_year: int) -> tuple[dict | None, str]:
    """반환은 (데이터, 실패 사유) 쌍. 사유는 다음 실행에서 왜 안 채워졌는지 로그로
    바로 알아보기 위한 것 — 예전에는 여기서 예외가 나면 fundamentals.py의 범용
    except가 그냥 삼켜서 "실패 20개"라는 숫자만 남고 원인이 하나도 안 보였다.
    """
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
    status = body.get("status")
    if status != "000":
        # DART 상태 코드: 013=조회된 데이터 없음, 020=일일 요청 한도 초과,
        # 800=시스템 점검, 900=정의되지 않은 오류. 코드를 그대로 남겨야 원인을 안다.
        return None, f"dart_status_{status}"
    rows = body.get("list") or []
    parsed = _parse_year(rows, bsns_year)
    if parsed is None:
        # 매출액·당기순이익 계정 둘 다 못 찾음. "영업수익" 폴백을 넣었는데도 여전히
        # 실패하는 업종(증권·보험·은행 등)이 있어, 실제 계정명을 사유에 실어 보낸다 —
        # 이 네트워크에서 DART를 직접 호출할 수 없으니, 다음 실행 로그 자체가
        # "정답은 이 이름을 폴백에 추가하면 된다"를 알려주는 진단이 되게 한다.
        seen = sorted({r["account_nm"] for r in rows if r.get("account_nm")})
        sample = ",".join(seen[:6])
        return None, f"no_key_accounts:{sample}" if sample else "no_key_accounts"
    return parsed, "ok"


def extract(
    ticker: str,
    latest_year: int,
    *,
    name: str | None = None,
    name_to_ticker: dict[str, str] | None = None,
) -> tuple[dict | None, str]:
    """fundamentals.py의 _extract()와 같은 모양의 dict를 반환해 저장 로직을 그대로 쓴다.

    반환은 (데이터, 실패 사유) 쌍. 데이터가 있으면 사유는 "ok" 또는
    "ok_via_common_stock"(우선주라 보통주 corp_code로 조회한 경우).

    name/name_to_ticker: 우선주 폴백용. ticker 자체가 corpCode.xml에 없으면
    이름에서 "우"/"N우B" 접미사를 떼어 보통주 이름을 찾고, name_to_ticker로
    그 보통주의 corp_code를 대신 쓴다. 재무제표는 법인 단위라 보통주 쪽 값을
    그대로 써도 회계적으로 맞다 — 없으면(호출부가 안 넘기면) 이 폴백은 그냥
    건너뛴다.

    latest_year 사업보고서가 아직 제출 전이면(연초~3월, 제출기한은 회계연도
    종료 후 3개월) 한 해 앞으로 물러나 재시도한다.
    """
    api_key = _api_key()
    if not api_key:
        return None, "no_api_key"

    try:
        corp_codes = _load_corp_codes(api_key)
    except Exception as exc:  # noqa: BLE001
        return None, f"corp_code_load_error_{type(exc).__name__}"

    corp_code = corp_codes.get(ticker)
    used_common_stock = False
    if not corp_code and name and name_to_ticker:
        base_name = _strip_preferred_suffix(name)
        if base_name:
            common_ticker = name_to_ticker.get(base_name)
            if common_ticker and common_ticker != ticker:
                candidate = corp_codes.get(common_ticker)
                if candidate:
                    corp_code = candidate
                    used_common_stock = True

    if not corp_code:
        return None, "corp_code_not_found"

    ok_reason = "ok_via_common_stock" if used_common_stock else "ok"
    last_reason = "no_data"
    for year in (latest_year, latest_year - 1):
        try:
            result, reason = _fetch_year(corp_code, api_key, year)
        except Exception as exc:  # noqa: BLE001
            result, reason = None, f"http_error_{type(exc).__name__}"
        if result is not None:
            return result, ok_reason
        last_reason = reason
    return None, last_reason
