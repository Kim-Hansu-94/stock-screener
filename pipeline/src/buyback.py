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

# 주요사항보고서 주요정보 API 후보. 어느 이름이 살아 있는지 작업 컨테이너에서
# 확인할 수 없어(DART 접속이 막혀 있다) 후보를 두고 프로브로 Actions에서 본다.
# 실패해도 아래 list.json 경로로 공시 이력은 남으므로 기능이 통째로 죽지는 않는다.
_DETAIL_ENDPOINTS = (
    ("자기주식 취득 결정", "tsstkAqDecsn"),
    ("자기주식취득 신탁계약 체결", "tsstkAqTrctrCnsCnc"),
    ("자기주식 처분 결정", "tsstkDpDecsn"),
)

# 응답 키 이름도 고정하지 않는다.
_PLANNED_AMOUNT_KEYS = ("aq_pl_tot_amount", "aqpln_prc_tot", "ctr_prc", "aq_amount", "trctr_cn_prc")
_ACQUIRED_AMOUNT_KEYS = ("aq_amount_ac", "aqd_amount", "aq_tot_amount")
_START_KEYS = ("aq_pd_bgd", "ctr_pd_bgd", "aq_bgd")
_END_KEYS = ("aq_pd_edd", "ctr_pd_edd", "aq_edd")


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


def _pick(row: dict, keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = row.get(key)
        if value not in (None, "", "-"):
            return str(value)
    return None


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    text = value.strip().replace(".", "-").replace("/", "-")
    if len(text) == 8 and text.isdigit():
        text = f"{text[:4]}-{text[4:6]}-{text[6:]}"
    try:
        return datetime.strptime(text[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


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
    return [
        r
        for r in rows
        if any(k in str(r.get("report_nm", "")) for k in _BUYBACK_KEYWORDS)
    ]


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


def _pick_by_pattern(row: dict, must: tuple[str, ...], avoid: tuple[str, ...] = ()) -> str | None:
    """키 이름에 특정 조각이 모두 들어간 칸을 찾는다.

    DART의 주요사항보고서 필드명은 보고서 종류마다 조금씩 다르다(aq_pl_tot_amount /
    aqpln_prc_tot / ...). 후보를 일일이 나열하는 것만으로는 새 표기가 나올 때마다
    조용히 None이 되므로, 고정 후보(_PLANNED_AMOUNT_KEYS 등)로 못 찾으면
    이름 패턴으로 한 번 더 훑는다.
    """
    for key, value in row.items():
        lowered = str(key).lower()
        if all(m in lowered for m in must) and not any(a in lowered for a in avoid):
            if value not in (None, "", "-"):
                return str(value)
    return None


def describe_detail(corp_code: str) -> list[str]:
    """프로브용 진단 — 상세 API가 실제로 어떤 키를 주는지 그대로 찍는다.

    "진행률=None"만 봐서는 API가 안 온 건지, 왔는데 키 이름이 다른 건지 알 수 없다.
    여기서 원본 키를 보여 주면 _PLANNED_AMOUNT_KEYS 등에 무엇을 추가해야 하는지가
    바로 나온다.
    """
    api_key = _api_key()
    if not api_key:
        return ["      DART_API_KEY 미설정"]
    lines: list[str] = []
    for label, endpoint in _DETAIL_ENDPOINTS:
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
        # 금액·날짜로 보이는 칸만 값까지 보여 준다 — 전부 찍으면 로그가 넘친다.
        interesting = {
            k: v
            for k, v in sample.items()
            if any(t in str(k).lower() for t in ("amount", "prc", "qy", "bgd", "edd", "de"))
        }
        lines.append(f"        값 예시={interesting}")
    return lines


def build_row(ticker: str, name: str, corp_code: str) -> dict | None:
    """DB(`stock_buyback`)에 넣을 한 행. 자사주 공시가 없으면 None.

    None과 예외를 구분한다 — None은 "이 회사는 자사주를 안 산다"(정상, 대부분의
    종목), 예외는 "못 받았다"(진단이 필요)다.
    """
    api_key = _api_key()
    if not api_key:
        raise RuntimeError("DART_API_KEY 미설정")

    detail_row: dict | None = None
    detail_kind: str | None = None
    detail_errors: list[str] = []
    for label, endpoint in _DETAIL_ENDPOINTS:
        try:
            rows = _detail(corp_code, api_key, endpoint)
        except Exception as exc:  # noqa: BLE001
            detail_errors.append(f"{label}: {exc}")
            continue
        if rows:
            # 가장 최근 공시 하나만 본다 — 진행 중인 프로그램은 보통 하나다.
            detail_row = rows[-1]
            detail_kind = label
            break

    disclosures = _disclosure_list(corp_code, api_key)
    if detail_row is None and not disclosures:
        return None

    planned = acquired = None
    start = end = None
    if detail_row is not None:
        # 고정 후보로 먼저 찾고, 없으면 키 이름 패턴으로 한 번 더 훑는다.
        planned = to_number(
            _pick(detail_row, _PLANNED_AMOUNT_KEYS)
            # 예정 금액: 이름에 'amount'(또는 'prc')가 들어가되 '취득 완료'를 뜻하는
            # 접미사(_ac)는 피한다.
            or _pick_by_pattern(detail_row, ("pl", "amount"), avoid=("_ac",))
            or _pick_by_pattern(detail_row, ("tot", "amount"), avoid=("_ac",))
        )
        acquired = to_number(
            _pick(detail_row, _ACQUIRED_AMOUNT_KEYS)
            or _pick_by_pattern(detail_row, ("amount", "_ac"))
        )
        start = _parse_date(
            _pick(detail_row, _START_KEYS) or _pick_by_pattern(detail_row, ("bgd",))
        )
        end = _parse_date(_pick(detail_row, _END_KEYS) or _pick_by_pattern(detail_row, ("edd",)))

    amount_progress = None
    if planned and planned > 0 and acquired is not None:
        amount_progress = min(acquired / planned * 100, 100.0)

    period_progress = None
    if start and end and end > start:
        elapsed = (date.today() - start).days
        period_progress = max(0.0, min(elapsed / (end - start).days * 100, 100.0))

    latest = disclosures[-1] if disclosures else None
    latest_name = str(latest.get("report_nm", "")).strip() if latest else (detail_kind or "")
    return {
        "market": "KR",
        "ticker": ticker,
        "name": name,
        "corp_code": corp_code,
        "latest_report": latest_name[:200],
        "latest_report_date": _parse_date(latest.get("rcept_dt") if latest else None).isoformat()
        if latest and _parse_date(latest.get("rcept_dt"))
        else None,
        # 공시 원문 링크 — 화면에서 "근거 보기"로 바로 연결한다.
        "latest_report_url": (
            f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={latest['rcept_no']}"
            if latest and latest.get("rcept_no")
            else None
        ),
        "is_disposal": bool(latest_name and any(k in latest_name for k in _DISPOSAL_KEYWORDS)),
        "planned_amount": planned,
        "acquired_amount": acquired,
        "amount_progress_pct": amount_progress,
        "period_progress_pct": period_progress,
        "period_start": start.isoformat() if start else None,
        "period_end": end.isoformat() if end else None,
        "disclosure_count": len(disclosures),
        "detail_source": detail_kind,
        "detail_error": " / ".join(detail_errors)[:300] if (detail_row is None and detail_errors) else None,
    }


def load_corp_codes() -> dict[str, str]:
    """종목코드 → DART corp_code. dart_fundamentals의 캐시를 그대로 쓴다."""
    from .dart_fundamentals import _api_key as fundamentals_key, _load_corp_codes

    key = fundamentals_key()
    if not key:
        raise RuntimeError("DART_API_KEY 미설정")
    return _load_corp_codes(key)
