"""목표주가 컨센서스 — 증권사들이 이 종목을 얼마로 보고 있나.

보물지도는 목표가를 ATR로 자체 계산한다(`frontend/lib/risk.ts`). 그건 "이 자리에서
손익비가 맞는가"를 보는 값이라 유용하지만, 근거가 한 겹뿐이다. 여기에 "증권사
평균 목표가"가 붙으면 서로 다른 근거 두 개를 나란히 볼 수 있다.

**둘을 합쳐 하나의 숫자로 만들지 않는다.** 성격이 다르기 때문이다 — ATR 목표가는
변동성 기반의 단기 매매 목표고, 컨센서스는 애널리스트의 12개월 밸류에이션이다.
평균 내면 둘 다 아닌 값이 된다.

소스는 네이버다. 어느 경로가 살아 있는지 알 수 없어(작업 컨테이너에서 네이버가
막혀 있어 여기서 확인이 안 된다) 후보를 순서대로 두고 프로브
(`python -m src.kr_extras_probe`)로 Actions에서 확인한다 — universe_us.py의
Russell 3000 소스와 같은 방식이다.
"""

from __future__ import annotations

from .naver_api import find_first, get_json, to_number

# 후보 1: 네이버 모바일 종목 통합 API. 종목 화면이 실제로 부르는 경로라 값이 있으면
#         가장 가볍다(종목당 1회).
_INTEGRATION_URL = "https://m.stock.naver.com/api/stock/{code}/integration"
# 후보 2: 같은 API의 basic 경로. 통합 응답이 얇아지는 경우를 대비.
_BASIC_URL = "https://m.stock.naver.com/api/stock/{code}/basic"
# 후보 3: 네이버 리서치(WISEreport) 컨센서스 페이지의 JSON 경로.
_WISE_URL = "https://navercomp.wisereport.co.kr/company/ajax/cF1001.aspx"

# 응답 키 이름이 경로마다 다르다. 경로를 고정하지 않고 후보 이름으로 찾는다.
_TARGET_KEYS = ("targetPrice", "trgtPrc", "consensusTargetPrice", "objPrice", "gsTargetPrice")
_OPINION_KEYS = ("investmentOpinion", "opinion", "consensusOpinion", "invOpinion")
_COUNT_KEYS = ("estimateCount", "consensusCount", "reportCount", "analystCount")
_EPS_KEYS = ("consensusEps", "estimateEps", "eps")


def _from_url(url_template: str, code: str) -> dict:
    payload = get_json(url_template.format(code=code), None if "{code}" in url_template else {"cmp_cd": code})
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
    ("네이버 통합 API", _INTEGRATION_URL),
    ("네이버 basic API", _BASIC_URL),
    ("네이버 리서치(WISEreport)", _WISE_URL),
)


def fetch_consensus(ticker: str) -> tuple[dict, str]:
    """한 종목의 컨센서스. (값, 사용한 소스 이름).

    전부 실패하면 사유를 모아 RuntimeError — 조용히 None을 돌려주면 "컨센서스가
    없는 종목"(커버하는 증권사가 없는 소형주는 실제로 흔하다)과 구분이 안 된다.
    """
    errors: list[str] = []
    for name, url in _SOURCES:
        try:
            return _from_url(url, ticker), name
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: {exc}")
    raise RuntimeError(" / ".join(errors))


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
