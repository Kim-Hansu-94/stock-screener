"""목표주가 컨센서스 — 증권사들이 이 종목을 얼마로 보고 있나.

보물지도는 목표가를 ATR로 자체 계산한다(`frontend/lib/risk.ts`). 그건 "이 자리에서
손익비가 맞는가"를 보는 값이라 유용하지만, 근거가 한 겹뿐이다. 여기에 "증권사
평균 목표가"가 붙으면 서로 다른 근거 두 개를 나란히 볼 수 있다.

**둘을 합쳐 하나의 숫자로 만들지 않는다.** 성격이 다르기 때문이다 — ATR 목표가는
변동성 기반의 단기 매매 목표고, 컨센서스는 애널리스트의 12개월 밸류에이션이다.
평균 내면 둘 다 아닌 값이 된다.

## 소스

네이버 종목 화면의 "투자의견·목표주가"는 네이버가 직접 계산하는 게 아니라
**WISEreport(에프앤가이드)** 페이지를 iframe으로 끼워 넣은 것이다. 그래서
모바일 API(`m.stock.naver.com/api/stock/{code}/integration`)에는 목표주가가 아예
없다 — 2026-09-10 프로브에서 "목표주가 값을 찾지 못함"으로 확인했다. 값이 실제로
있는 곳은 WISEreport 쪽이고, 응답이 JSON이 아니라 **HTML 표**다.

그래서 순서를 뒤집었다: HTML 표(1순위) → 모바일 API(2순위, 나중에 필드가 생기면
자동으로 잡히도록 남겨 둠).
"""

from __future__ import annotations

import io
import re

import pandas as pd
import requests

from .naver_api import HEADERS, TIMEOUT, find_first, get_json, to_number

# WISEreport 기업개요 페이지. 네이버 종목 화면이 iframe으로 부르는 바로 그 주소다.
_WISE_COMPANY_URL = "https://navercomp.wisereport.co.kr/v2/company/c1010001.aspx"
# 모바일 API — 지금은 목표주가가 없지만, 생기면 여기가 가장 가볍다(종목당 1회).
_INTEGRATION_URL = "https://m.stock.naver.com/api/stock/{code}/integration"

_TARGET_KEYS = ("targetPrice", "trgtPrc", "consensusTargetPrice", "objPrice", "gsTargetPrice")
_OPINION_KEYS = ("investmentOpinion", "opinion", "consensusOpinion", "invOpinion")
_COUNT_KEYS = ("estimateCount", "consensusCount", "reportCount", "analystCount")
_EPS_KEYS = ("consensusEps", "estimateEps", "eps")

# 목표주가가 이 범위를 벗어나면 엉뚱한 칸을 읽은 것이다(예: 시가총액, 상장주식수).
# 국내 주식은 액면가 100원짜리도 있고 삼성전자 우선주도 있어 하한을 낮게 잡는다.
_MIN_TARGET = 100
_MAX_TARGET = 100_000_000


def _fetch_html(url: str, code: str) -> str:
    resp = requests.get(url, params={"cmp_cd": code}, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    # WISEreport는 EUC-KR이다. 지정하지 않으면 '목표주가'가 깨져 라벨 매칭이 전부 실패한다.
    if not resp.encoding or resp.encoding.lower() in ("iso-8859-1",):
        resp.encoding = "euc-kr"
    return resp.text


def _is_valid_target(value: float | None) -> bool:
    return value is not None and _MIN_TARGET <= value <= _MAX_TARGET


# 투자의견은 1~5 점수로 온다(에프앤가이드 표준: 5=적극매수 … 1=매도). 네이버 화면도
# 숫자를 그대로 보여주지만, 사이트에서는 무슨 뜻인지 바로 읽히게 한글을 같이 붙인다.
_OPINION_LABELS_BY_SCORE = (
    (4.5, "적극매수"),
    (3.5, "매수"),
    (2.5, "중립"),
    (1.5, "비중축소"),
    (0.0, "매도"),
)


def opinion_label(score: float | None) -> str | None:
    """투자의견 점수 → 한글 라벨. 점수도 같이 남긴다(예: '매수 4.05')."""
    if score is None:
        return None
    for threshold, label in _OPINION_LABELS_BY_SCORE:
        if score >= threshold:
            return f"{label} {score:.2f}"
    return None


def _consensus_from_table(table: pd.DataFrame) -> dict | None:
    """컨센서스 표 하나에서 값을 뽑는다. 그 표가 아니면 None.

    2026-09-10 프로브가 찍어 준 실제 구조(WISEreport 기업개요, 표 11번):

        ['4.05', '투자의견', '목표주가(원)', 'EPS(원)', 'PER(배)', '추정기관수']
        ['4.05', '4.05',    '488409',      '48239',  '5.59',   '22']

    즉 **헤더가 행이고 값은 바로 아래 행**이다. 처음에는 라벨 오른쪽 칸을 읽어
    옆 헤더인 'EPS(원)'을 투자의견으로 집었다. 표를 '투자의견'과 '목표주가'가
    함께 있는 것으로 한정하고, 열 위치를 헤더 이름으로 찾는다 — 열 순서를
    고정하면 항목이 하나 추가되는 순간 전부 밀린다.
    """
    values = table.astype(str).values
    for r, row in enumerate(values):
        headers = [str(cell).replace(" ", "") for cell in row]
        if not (any("목표주가" in h for h in headers) and any("투자의견" in h for h in headers)):
            continue
        if r + 1 >= len(values):
            continue
        data_row = values[r + 1]

        found: dict = {}
        for c, header in enumerate(headers):
            raw = str(data_row[c]).strip()
            if raw.lower() in ("", "nan", "-"):
                continue
            number = to_number(raw)
            if "목표주가" in header:
                found["target_price"] = number
            elif "투자의견" in header:
                found["opinion_score"] = number
            elif header.upper().startswith("EPS"):
                found["consensus_eps"] = number
            elif "추정기관" in header:
                found["report_count"] = number

        if _is_valid_target(found.get("target_price")):
            return found
    return None


def _from_wise(url: str, code: str) -> dict:
    html = _fetch_html(url, code)
    if "목표주가" not in html:
        raise RuntimeError("'목표주가'가 응답에 없음 (페이지 개편 또는 차단)")

    tables = pd.read_html(io.StringIO(html))
    for table in tables:
        found = _consensus_from_table(table)
        if found is None:
            continue
        return {
            "target_price": found["target_price"],
            "opinion": opinion_label(found.get("opinion_score")),
            "report_count": found.get("report_count"),
            "consensus_eps": found.get("consensus_eps"),
        }
    raise RuntimeError(f"컨센서스 표를 못 찾음 (표 {len(tables)}개)")


def _from_integration(code: str) -> dict:
    payload = get_json(_INTEGRATION_URL.format(code=code))
    target = to_number(find_first(payload, _TARGET_KEYS))
    if target is None or target <= 0:
        raise RuntimeError("목표주가 값을 찾지 못함")
    opinion = find_first(payload, _OPINION_KEYS)
    return {
        "target_price": target,
        "opinion": None if opinion is None else str(opinion)[:40],
        "report_count": to_number(find_first(payload, _COUNT_KEYS)),
        "consensus_eps": to_number(find_first(payload, _EPS_KEYS)),
    }


_SOURCES = (
    ("WISEreport 기업개요", lambda code: _from_wise(_WISE_COMPANY_URL, code)),
    # 모바일 API에는 2026-09-10 기준 목표주가 필드가 없다(프로브로 확인). 나중에
    # 생기면 여기가 가장 가벼우므로(종목당 1회 JSON) 후보로 남겨 둔다 — 앞 소스가
    # 성공하면 호출조차 되지 않아 비용은 0이다.
    ("네이버 통합 API", _from_integration),
)


def fetch_consensus(ticker: str) -> tuple[dict, str]:
    """한 종목의 컨센서스. (값, 사용한 소스 이름).

    전부 실패하면 사유를 모아 RuntimeError — 조용히 None을 돌려주면 "컨센서스가
    없는 종목"(커버하는 증권사가 없는 소형주는 실제로 흔하다)과 구분이 안 된다.
    """
    errors: list[str] = []
    for name, fetch in _SOURCES:
        try:
            return fetch(ticker), name
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: {exc}")
    raise RuntimeError(" / ".join(errors))


def describe_sources(ticker: str) -> list[str]:
    """프로브용 진단 — '목표주가'가 들어 있는 표를 통째로 찍는다.

    "값을 못 읽음"만으로는 어느 칸을 봐야 하는지 알 수 없고, 더 나쁜 건 **엉뚱한
    칸을 읽고도 그럴듯한 숫자라 성공처럼 보이는 것**이다(2026-09-10 2차 프로브에서
    실제로 그랬다 — 삼성전자 목표가를 488,409원으로 읽고 투자의견을 '목표주가원'
    이라는 헤더 텍스트로 읽었다). 그래서 구조를 그대로 보여 준다.
    """
    lines: list[str] = []
    try:
        html = _fetch_html(_WISE_COMPANY_URL, ticker)
    except Exception as exc:  # noqa: BLE001
        return [f"      WISEreport 요청 실패: {exc}"]

    try:
        tables = pd.read_html(io.StringIO(html))
    except Exception as exc:  # noqa: BLE001
        return [f"      WISEreport {len(html)}자, 표 파싱 실패: {exc}"]

    lines.append(f"      WISEreport {len(html)}자, 표 {len(tables)}개")
    for index, table in enumerate(tables):
        text = " ".join(str(v) for v in table.astype(str).values.flatten())
        if "목표주가" not in text:
            continue
        lines.append(f"      [표 {index}] shape={table.shape} 컬럼={list(table.columns)[:6]}")
        for row in table.astype(str).values[:4]:
            lines.append(f"        {list(row)[:8]}")
    return lines


def build_row(ticker: str, name: str, as_of: str, close: float | None) -> dict:
    """DB(`stock_consensus`)에 넣을 한 행."""
    data, source = fetch_consensus(ticker)
    target = data["target_price"]
    return {
        "market": "KR",
        "ticker": ticker,
        "name": name,
        "date": as_of,
        "target_price": target,
        # 현재가 대비 상승여력. 화면에서 매번 계산하지 않도록 여기서 넣는다
        # (종가가 없으면 화면이 최신 종가로 직접 계산한다).
        "upside_pct": None if not close else (target / close - 1) * 100,
        "opinion": data["opinion"],
        "report_count": None if data["report_count"] is None else int(data["report_count"]),
        "consensus_eps": data["consensus_eps"],
        "source": source,
    }
