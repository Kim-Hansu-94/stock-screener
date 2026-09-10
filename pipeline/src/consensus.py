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

# HTML 표에서 찾을 항목 이름. 표 구조(행/열 위치)를 고정하면 개편 한 번에 죽으므로
# 이름으로 찾는다.
_TARGET_LABELS = ("목표주가",)
_OPINION_LABELS = ("투자의견",)
_EPS_LABELS = ("EPS",)

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


def _value_near_label(
    tables: list[pd.DataFrame],
    labels: tuple[str, ...],
    accept=lambda v: v is not None,
) -> str | None:
    """라벨 칸을 찾아 그 **오른쪽(가로형)** 또는 **아래쪽(세로형)** 값을 돌려준다.

    2026-09-10 프로브에서 확인한 것: WISEreport 기업개요의 컨센서스 표는 세로형이라
    '목표주가'가 헤더 행에 있고 값은 그 아래 행에 있다. 오른쪽만 보던 첫 구현은
    옆 칸 헤더인 'EPS(원)'을 읽어 왔다.

    어느 방향이 맞는지 표마다 다르므로 둘 다 시도하고, `accept`를 통과하는 값을
    고른다 — 방향을 고정하면 표 개편 한 번에 또 엉뚱한 칸을 읽는다.
    """
    for table in tables:
        values = table.astype(str).values
        for r, row in enumerate(values):
            for c, cell in enumerate(row):
                text = str(cell).replace(" ", "")
                if not any(label.replace(" ", "") in text for label in labels):
                    continue
                candidates: list[str] = []
                # 가로형: 같은 행의 오른쪽 칸들
                candidates.extend(str(v).strip() for v in row[c + 1 :])
                # 세로형: 같은 열의 아래 행들
                candidates.extend(str(values[rr][c]).strip() for rr in range(r + 1, len(values)))
                for candidate in candidates:
                    if not candidate or candidate.lower() == "nan":
                        continue
                    if accept(to_number(candidate)) or accept(candidate):
                        return candidate
    return None


def _from_wise(url: str, code: str) -> dict:
    html = _fetch_html(url, code)
    if "목표주가" not in html:
        raise RuntimeError("'목표주가'가 응답에 없음 (페이지 개편 또는 차단)")

    tables = pd.read_html(io.StringIO(html))
    raw_target = _value_near_label(tables, _TARGET_LABELS, accept=_is_valid_target_any)
    target = to_number(raw_target)
    if not _is_valid_target(target):
        raise RuntimeError(f"목표주가 칸을 못 읽음 (표 {len(tables)}개, 읽은 값={raw_target!r})")

    # 투자의견은 "4.00매수"처럼 점수와 의견이 붙어 오거나 한글만 오기도 한다.
    # 숫자만 있는 칸(옆 열의 EPS 등)을 잘못 집지 않도록 한글이 들어간 값만 받는다.
    opinion_raw = _value_near_label(tables, _OPINION_LABELS, accept=_has_korean)
    opinion = None
    if opinion_raw:
        korean = "".join(re.findall(r"[가-힣]+", str(opinion_raw)))
        opinion = (korean or str(opinion_raw).strip())[:40] or None

    return {
        "target_price": target,
        "opinion": opinion,
        "report_count": None,
        "consensus_eps": to_number(_value_near_label(tables, _EPS_LABELS, accept=lambda v: isinstance(v, float))),
    }


def _is_valid_target_any(value) -> bool:
    """_value_near_label이 숫자·문자열을 모두 넘겨 오므로 숫자일 때만 판정한다."""
    return isinstance(value, float) and _is_valid_target(value)


def _has_korean(value) -> bool:
    return isinstance(value, str) and bool(re.search(r"[가-힣]", value))


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
