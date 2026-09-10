"""자사주 매입 진행률 — DART(전자공시) Open API.

국내 주주환원 테마에서 가장 직접적인 재료인데 보물지도엔 없던 정보다. 자사주를
사들이는 동안에는 회사 자신이 매수 주체로 들어오므로, 눌림목·조정 구간의 하방을
받쳐 주는 요인이 된다.

소스로 네이버가 아니라 DART를 쓴 이유: 자사주 취득은 **공시 의무 사항**이라 원본이
DART에 있고, 네이버·증권사 화면도 결국 이걸 받아 보여준다. `DART_API_KEY`는
이미 등록돼 있어(2026-09-01) 새 시크릿도 필요 없다.

**"진행률"이 무엇인지 정확히 해 둘 것.** 여기서 내는 값은 두 종류이고 뜻이 다르다:

- `amount_progress_pct` — 취득 **금액** 기준. 공시에 이미 취득한 금액이 들어 있는
  경우(취득 결과보고서·신탁계약 진행 상황)에만 채워진다. 진짜 진행률이다.
- `period_progress_pct` — 취득 **기간** 기준. 시작일~종료일 중 오늘이 어디쯤인지.
  금액을 모를 때의 근사치이며, 회사가 앞에서 몰아 사면 실제보다 낮게 나온다.

둘을 하나로 합치지 않는다 — 합치면 화면에서 어느 쪽 근거인지 알 수 없게 된다.
화면은 금액 기준이 있으면 그걸 쓰고, 없으면 기간 기준임을 라벨로 밝힌다.
"""

from __future__ import annotations

import os
import re
from datetime import date, datetime, timedelta

import requests

from .naver_api import to_number

_BASE = "https://opendart.fss.or.kr/api"

# 최근 2년치 공시만 본다. 자사주 취득은 보통 3~6개월 프로그램이라 그 이전 건은
# 이미 끝났고, 목록을 넓히면 응답만 커진다.
_LOOKBACK_DAYS = 730

# 자기주식 관련 공시를 골라내는 키워드. 보고서명이 회사·유형마다 조금씩 달라서
# ("자기주식 취득 결정", "자기주식취득 신탁계약 체결 결정", "자기주식 처분 결정")
# 정확한 이름 대신 포함 여부로 판단한다.
_BUYBACK_KEYWORDS = ("자기주식", "자사주")
# 처분(파는 것)은 매입과 방향이 정반대라 따로 표시해야 한다.
_DISPOSAL_KEYWORDS = ("처분", "매각")

# 주요사항보고서 주요정보 API. 2026-09-10 프로브로 실제 응답을 확인하고 필드명을
# 고정했다(그 전에는 이름을 짐작해 두고 있었다).
#
# 자기주식취득 신탁계약 체결(tsstkAqTrctrCnsCnc)은 **그런 엔드포인트가 없다**
# (DART status=101 "잘못된 URL"). 후보로 남겨 두면 종목마다 헛호출이 한 번씩
# 늘어나므로 뺐다.
_DETAIL_ENDPOINTS = (
    ("자기주식 취득 결정", "tsstkAqDecsn", False),
    ("자기주식 처분 결정", "tsstkDpDecsn", True),
)

# 취득(aq)과 처분(dp)은 필드 접두어가 다르다. 금액은 보통주(ostk)와 기타주식(estk)이
# 따로 오고, 기타주식이 없으면 '-'로 온다 — 둘을 더해야 프로그램 전체 규모가 된다.
_FIELDS = {
    # (예정금액 열들, 예정수량 열들, 기간 시작, 기간 종료, 결의일)
    False: (("aqpln_prc_ostk", "aqpln_prc_estk"), ("aqpln_stk_ostk", "aqpln_stk_estk"), "aqexpd_bgd", "aqexpd_edd", "aq_dd"),
    True: (("dppln_prc_ostk", "dppln_prc_estk"), ("dppln_stk_ostk", "dppln_stk_estk"), "dpprpd_bgd", "dpprpd_edd", "dp_dd"),
}

def _api_key() -> str | None:
    return os.environ.get("DART_API_KEY") or None


def _get(path: str, params: dict) -> dict:
    resp = requests.get(f"{_BASE}/{path}.json", params=params, timeout=25)
    resp.raise_for_status()
    try:
        payload = resp.json()
    except ValueError:
        raise RuntimeError(f"JSON이 아닌 응답: {(resp.text or '')[:150]}") from None
    status = payload.get("status")
    # DART는 '조회된 데이터가 없습니다'(013)도 HTTP 200 + status로 준다. 이건
    # 오류가 아니라 "그런 공시가 없음"이므로 빈 결과로 취급해야 한다.
    if status == "013":
        return {"list": []}
    if status not in (None, "000"):
        raise RuntimeError(f"DART status={status} {payload.get('message')}")
    return payload


# DART 주요사항보고서는 날짜를 "2026년 03월 19일"로 준다(list.json의 rcept_dt는
# "20260821"). 둘 다 받아야 한다 — 한쪽만 처리하면 조용히 None이 되어 기간
# 진행률이 통째로 빈다(2026-09-10 프로브에서 실제로 그랬다).
_KOREAN_DATE = re.compile(r"(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일")


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    text = str(value).strip()
    korean = _KOREAN_DATE.search(text)
    if korean:
        year, month, day = (int(g) for g in korean.groups())
        try:
            return date(year, month, day)
        except ValueError:
            return None
    text = text.replace(".", "-").replace("/", "-")
    if len(text) == 8 and text.isdigit():
        text = f"{text[:4]}-{text[4:6]}-{text[6:]}"
    try:
        return datetime.strptime(text[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _sum_amounts(row: dict, keys: tuple[str, ...]) -> float | None:
    """보통주·기타주식 금액을 더한다. 둘 다 비어 있으면 None."""
    total = None
    for key in keys:
        value = to_number(row.get(key))
        if value is not None:
            total = value if total is None else total + value
    return total


def _disclosure_list(corp_code: str, api_key: str) -> list[dict]:
    """최근 자기주식 관련 공시 목록. 상세 API가 다 막혀도 이건 남는다."""
    begin = (date.today() - timedelta(days=_LOOKBACK_DAYS)).strftime("%Y%m%d")
    payload = _get(
        "list",
        {
            "crtfc_key": api_key,
            "corp_code": corp_code,
            "bgn_de": begin,
            "end_de": date.today().strftime("%Y%m%d"),
            "page_count": 100,
        },
    )
    rows = payload.get("list") or []
    matched = [r for r in rows if any(k in str(r.get("report_nm", "")) for k in _BUYBACK_KEYWORDS)]
    # DART list.json은 최신순(내림차순)으로 준다 — 그대로 [-1]을 쓰면 **가장 오래된**
    # 공시를 "최신"으로 표시하게 된다(2026-09-10 2차 프로브: SK하이닉스가 8월
    # 취득결정 대신 4월 처분결정으로 표시됐다). 날짜로 직접 줄 세운다.
    matched.sort(key=lambda r: str(r.get("rcept_dt") or ""))
    return matched


def _detail(corp_code: str, api_key: str, endpoint: str) -> list[dict]:
    begin = (date.today() - timedelta(days=_LOOKBACK_DAYS)).strftime("%Y%m%d")
    payload = _get(
        endpoint,
        {
            "crtfc_key": api_key,
            "corp_code": corp_code,
            "bgn_de": begin,
            "end_de": date.today().strftime("%Y%m%d"),
        },
    )
    return payload.get("list") or []


def describe_detail(corp_code: str) -> list[str]:
    """프로브용 진단 — 상세 API가 실제로 어떤 키를 주는지 그대로 찍는다.

    "진행률=None"만 봐서는 API가 안 온 건지, 왔는데 키 이름이 다른 건지 알 수 없다.
    2026-09-10에 이 출력으로 실제 필드명(aqpln_prc_ostk 등)을 확정했다.
    """
    api_key = _api_key()
    if not api_key:
        return ["      DART_API_KEY 미설정"]
    lines: list[str] = []
    for label, endpoint, _ in _DETAIL_ENDPOINTS:
        try:
            rows = _detail(corp_code, api_key, endpoint)
        except Exception as exc:  # noqa: BLE001
            lines.append(f"      {label}({endpoint}): 실패 {exc}")
            continue
        if not rows:
            lines.append(f"      {label}({endpoint}): 0건")
            continue
        sample = rows[-1]
        lines.append(f"      {label}({endpoint}): {len(rows)}건, 키={sorted(sample.keys())}")
        interesting = {
            k: v
            for k, v in sample.items()
            if any(t in str(k).lower() for t in ("prc", "stk_", "bgd", "edd", "_dd"))
        }
        lines.append(f"        값 예시={interesting}")
    return lines


def _latest_program(corp_code: str, api_key: str) -> tuple[dict, bool, str] | None:
    """취득·처분 공시를 모두 받아 **가장 최근 결의** 한 건을 고른다.

    엔드포인트 순서대로 첫 응답을 쓰면, 처분 공시가 더 최근인 회사도 오래된 취득
    공시로 표시된다(2026-09-10 프로브: SK하이닉스가 최신은 처분결정인데 취득으로
    잡혔다). 방향이 정반대인 두 사건이라 이건 그냥 틀린 값이다.
    """
    best: tuple[date, dict, bool, str] | None = None
    errors: list[str] = []
    for label, endpoint, is_disposal in _DETAIL_ENDPOINTS:
        try:
            rows = _detail(corp_code, api_key, endpoint)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{label}: {exc}")
            continue
        _, _, _, _, decision_key = _FIELDS[is_disposal]
        for row in rows:
            decided = _parse_date(row.get(decision_key))
            # 결의일이 안 읽히면 순서를 정할 수 없다 — 가장 뒤(=DART가 최신으로
            # 주는 쪽)를 아주 오래된 것으로 두고 다른 후보에 밀리게 한다.
            key = decided or date.min
            if best is None or key > best[0]:
                best = (key, row, is_disposal, label)
    if best is None:
        _LAST_DETAIL_ERRORS.clear()
        _LAST_DETAIL_ERRORS.extend(errors)
        return None
    return best[1], best[2], best[3]


# _latest_program이 아무 것도 못 찾았을 때의 사유. build_row가 detail_error에 담는다.
_LAST_DETAIL_ERRORS: list[str] = []


def build_row(ticker: str, name: str, corp_code: str) -> dict | None:
    """DB(`stock_buyback`)에 넣을 한 행. 자사주 공시가 없으면 None.

    None과 예외를 구분한다 — None은 "이 회사는 자사주를 안 산다"(정상, 대부분의
    종목), 예외는 "못 받았다"(진단이 필요)다.
    """
    api_key = _api_key()
    if not api_key:
        raise RuntimeError("DART_API_KEY 미설정")

    program = _latest_program(corp_code, api_key)
    disclosures = _disclosure_list(corp_code, api_key)
    if program is None and not disclosures:
        return None

    planned = planned_qty = None
    start = end = None
    is_disposal = False
    detail_kind = None
    if program is not None:
        detail_row, is_disposal, detail_kind = program
        amount_keys, qty_keys, start_key, end_key, _ = _FIELDS[is_disposal]
        planned = _sum_amounts(detail_row, amount_keys)
        planned_qty = _sum_amounts(detail_row, qty_keys)
        start = _parse_date(detail_row.get(start_key))
        end = _parse_date(detail_row.get(end_key))

    # 취득 **완료** 금액은 이 API에 없다. 주요사항보고서는 "얼마를 사겠다"는 계획
    # 공시이고, 실제 체결량은 별도의 자기주식취득결과보고서(전용 API 없음)에 있다.
    # 그래서 지금은 금액 기준 진행률이 항상 비고 기간 기준만 채워진다 — 화면이
    # 그 사실을 라벨로 밝히므로, 근사치를 진짜 진행률인 척 보여주지는 않는다.
    acquired = None
    amount_progress = None

    period_progress = None
    if start and end and end > start:
        elapsed = (date.today() - start).days
        period_progress = max(0.0, min(elapsed / (end - start).days * 100, 100.0))
    elif start and end and end == start:
        # 하루짜리 프로그램(당일 처분 등)은 시작=종료다. 0으로 나누지 않는다.
        period_progress = 100.0 if date.today() >= end else 0.0

    # 공시 목록에서도 **선택된 프로그램과 같은 방향**의 최신 건을 고른다.
    # 안 그러면 카드 제목은 '자사주 매입'인데 링크는 처분 공시로 걸린다
    # (SK하이닉스: 최신 결의는 8월 취득결정, 최신 공시는 8월 처분결과보고서).
    if program is not None and disclosures:
        same_direction = [
            d
            for d in disclosures
            if any(k in str(d.get("report_nm", "")) for k in _DISPOSAL_KEYWORDS) == is_disposal
        ]
        if same_direction:
            disclosures = same_direction
    latest = disclosures[-1] if disclosures else None
    latest_name = str(latest.get("report_nm", "")).strip() if latest else (detail_kind or "")
    latest_date = _parse_date(latest.get("rcept_dt")) if latest else None
    return {
        "market": "KR",
        "ticker": ticker,
        "name": name,
        "corp_code": corp_code,
        "latest_report": latest_name[:200],
        "latest_report_date": latest_date.isoformat() if latest_date else None,
        # 공시 원문 링크 — 화면에서 "근거 보기"로 바로 연결한다.
        "latest_report_url": (
            f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={latest['rcept_no']}"
            if latest and latest.get("rcept_no")
            else None
        ),
        # 방향은 상세 공시에서 판정한다. 공시 목록의 보고서명은 '자기주식취득결과보고서'
        # 처럼 표기가 다양해 문자열 매칭이 불안정하다.
        "is_disposal": is_disposal
        if program is not None
        else bool(latest_name and any(k in latest_name for k in _DISPOSAL_KEYWORDS)),
        "planned_amount": planned,
        "planned_qty": planned_qty,
        "acquired_amount": acquired,
        "amount_progress_pct": amount_progress,
        "period_progress_pct": period_progress,
        "period_start": start.isoformat() if start else None,
        "period_end": end.isoformat() if end else None,
        "disclosure_count": len(disclosures),
        "detail_source": detail_kind,
        "detail_error": " / ".join(_LAST_DETAIL_ERRORS)[:300] if program is None and _LAST_DETAIL_ERRORS else None,
    }


def load_corp_codes() -> dict[str, str]:
    """종목코드 → DART corp_code. dart_fundamentals의 캐시를 그대로 쓴다."""
    from .dart_fundamentals import _api_key as fundamentals_key, _load_corp_codes

    key = fundamentals_key()
    if not key:
        raise RuntimeError("DART_API_KEY 미설정")
    return _load_corp_codes(key)
