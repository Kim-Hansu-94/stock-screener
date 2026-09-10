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
# 같은 사이트의 컨센서스 전용 탭. 기업개요에 표가 없을 때를 대비한 2순위.
_WISE_CONSENSUS_URL = "https://navercomp.wisereport.co.kr/v2/company/cF3002.aspx"
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


def _cell_after_label(tables: list[pd.DataFrame], labels: tuple[str, ...]) -> str | None:
    """표들 중 라벨이 들어 있는 칸을 찾아, 같은 행의 다음 칸 값을 돌려준다."""
    for table in tables:
        values = table.astype(str).values
        for row in values:
            for index, cell in enumerate(row):
                text = cell.replace(" ", "")
                if any(label.replace(" ", "") in text for label in labels):
                    for candidate in row[index + 1 :]:
                        candidate = str(candidate).strip()
                        if candidate and candidate.lower() != "nan":
                            return candidate
    return None


def _from_wise(url: str, code: str) -> dict:
    html = _fetch_html(url, code)
    if "목표주가" not in html:
        raise RuntimeError("'목표주가'가 응답에 없음 (페이지 개편 또는 차단)")

    tables = pd.read_html(io.StringIO(html))
    target = to_number(_cell_after_label(tables, _TARGET_LABELS))
    if target is None or not (_MIN_TARGET <= target <= _MAX_TARGET):
        raise RuntimeError(f"목표주가 칸을 못 읽음 (표 {len(tables)}개, 읽은 값={target})")

    opinion = _cell_after_label(tables, _OPINION_LABELS)
    if opinion is not None:
        # "4.00매수" 처럼 점수와 의견이 붙어 오는 경우가 있다. 한글만 남긴다.
        korean = "".join(re.findall(r"[가-힣]+", opinion))
        opinion = korean or opinion.strip()

    return {
        "target_price": target,
        "opinion": (opinion or None) if opinion is None else str(opinion)[:40] or None,
        "report_count": None,
        "consensus_eps": to_number(_cell_after_label(tables, _EPS_LABELS)),
    }


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
    ("WISEreport 컨센서스", lambda code: _from_wise(_WISE_CONSENSUS_URL, code)),
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
    """프로브용 진단 — 소스별로 응답에 무엇이 들어 있는지 찍는다.

    "목표주가 값을 찾지 못함"만 봐서는 페이지가 막힌 건지, 표 구조가 바뀐 건지,
    애초에 그 페이지에 없는 건지 구분이 안 된다. 여기서 그 셋을 갈라 준다.
    """
    lines: list[str] = []
    for url, label in ((_WISE_COMPANY_URL, "기업개요"), (_WISE_CONSENSUS_URL, "컨센서스탭")):
        try:
            html = _fetch_html(url, ticker)
        except Exception as exc:  # noqa: BLE001
            lines.append(f"      WISEreport {label}: 요청 실패 {exc}")
            continue
        has_label = "목표주가" in html
        try:
            tables = pd.read_html(io.StringIO(html))
        except Exception as exc:  # noqa: BLE001
            lines.append(f"      WISEreport {label}: {len(html)}자, 목표주가문구={has_label}, 표 파싱 실패 {exc}")
            continue
        cell = _cell_after_label(tables, _TARGET_LABELS)
        lines.append(
            f"      WISEreport {label}: {len(html)}자, 목표주가문구={has_label}, "
            f"표 {len(tables)}개, 목표주가칸={cell!r}"
        )
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
