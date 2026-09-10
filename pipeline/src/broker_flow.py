"""거래원(증권사 창구별 매매) — 자사주 매입을 **진행 중에** 따라가기 위한 데이터.

## 왜 이게 필요한가

DART 주요사항보고서는 "얼마를 사겠다"는 계획 공시라 실제 매입량이 없다. 실제
매입량이 담긴 자기주식취득**결과**보고서는 프로그램이 **끝난 뒤에** 나온다 —
진행 중인 3~6개월 동안은 아무것도 알 수 없다는 뜻이다.

그런데 자사주 취득은 회사가 아무 창구로나 사는 게 아니라 **위탁투자중개업자**를
정해 공시한다(취득결정 공시의 `cs_iv_bk` 필드 — SK하이닉스는 SK증권). 거래소는
종목별 상위 매수·매도 창구를 매일 공개하므로, **그 증권사 창구의 일별 순매수**를
보면 자사주 매입을 진행 중에 따라갈 수 있다.

2026-09-10 프로브 실측: SK하이닉스 매수상위 1위가 SK증권 623,600주였다.

## 이건 확정치가 아니라 추정치다

그 창구의 매수가 전부 자사주는 아니다 — 같은 증권사의 일반 고객 주문이 섞인다.
그래서 이 값은 **추정**이고, 화면에서 반드시 그렇게 밝혀야 한다. 확정치는 나중에
결과보고서가 나오면 그걸로 대체한다(둘은 서로를 대체하지 않는다).

## 한계

네이버가 주는 건 **그날의 상위 5개 창구**뿐이다. 과거 이력은 안 준다.
- 그래서 매일 실행해 스냅샷을 쌓아야 하고, **오늘부터 쌓인다**(소급 불가)
- 그날 해당 증권사가 6위 밖이면 그날은 안 잡힌다 — 누락이지 0이 아니다.
  추정 진행률이 실제보다 **낮게** 나올 수 있다는 뜻이다
"""

from __future__ import annotations

import io
from datetime import date

import pandas as pd
import requests

from .naver_api import HEADERS, TIMEOUT, to_number

# 거래원 표가 들어 있는 페이지. 프로브(2026-09-10)로 둘 다 확인했다.
# main이 표가 더 깔끔해 1순위, frgn은 수급 수집에서도 쓰는 페이지라 2순위.
_SOURCES = (
    ("종목 메인", "https://finance.naver.com/item/main.naver?code={code}"),
    ("외국인·기관 탭", "https://finance.naver.com/item/frgn.naver?code={code}"),
)

# 표를 찾는 기준. **컬럼 이름을 값 추출에 쓰면 안 된다** — 네이버 쪽 오타가 있다
# (main 페이지의 매수 수량 컬럼이 '거개량'이다, 2026-09-10 프로브 확인).
# 그래서 표는 이 두 글자로 찾고, 값은 **열 위치**로 읽는다.
_TABLE_MARKERS = ("매도상위", "매수상위")

_SELL_NAME_COL, _SELL_QTY_COL, _BUY_NAME_COL, _BUY_QTY_COL = 0, 1, 2, 3


def _fetch_html(url: str) -> str:
    resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    # 네이버 금융은 EUC-KR이다. 지정 안 하면 증권사 이름이 깨져 매칭이 전부 실패한다.
    if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
        resp.encoding = "euc-kr"
    return resp.text


def _broker_table(html: str) -> pd.DataFrame | None:
    """거래원 표를 찾는다. 없으면 **왜 없는지가 드러나는 에러**를 낸다.

    2026-09-10 실측: 같은 URL이 17:07 KST에는 거래원 표를 주고(191,475자)
    21:57 KST에는 안 줬다(117,909자, '매수상위' 문구 자체가 없음). 시간대에 따라
    페이지가 달라진다는 뜻이다. 수집은 17:30에 돌아 지금은 맞지만, "표가 없다"와
    "표는 있는데 못 읽었다"를 구분해 두지 않으면 나중에 원인을 못 찾는다.
    """
    if not all(marker in html for marker in _TABLE_MARKERS):
        raise RuntimeError(
            f"거래원 섹션이 응답에 없음 ({len(html):,}자) — 이 페이지는 시간대에 따라 "
            "거래원을 주지 않는다(장 마감 직후에는 나온다)"
        )
    for table in pd.read_html(io.StringIO(html)):
        if table.shape[1] < 4:
            continue
        columns = " ".join(str(c) for c in table.columns)
        if all(m in columns for m in _TABLE_MARKERS):
            return table
    return None


def parse_brokers(html: str) -> dict[str, dict[str, float]]:
    """증권사 → {buy_qty, sell_qty, net_qty}. 상위 5개 창구만 들어 있다."""
    table = _broker_table(html)
    if table is None:
        raise RuntimeError("거래원 문구는 있으나 표 구조가 바뀜 (열 이름 확인 필요)")

    result: dict[str, dict[str, float]] = {}

    def add(name: object, qty: float | None, side: str) -> None:
        text = str(name).strip()
        if not text or text.lower() == "nan" or qty is None:
            return
        entry = result.setdefault(text, {"buy_qty": 0.0, "sell_qty": 0.0})
        entry[side] += qty

    for row in table.astype(str).values:
        if len(row) <= _BUY_QTY_COL:
            continue
        add(row[_SELL_NAME_COL], to_number(row[_SELL_QTY_COL]), "sell_qty")
        add(row[_BUY_NAME_COL], to_number(row[_BUY_QTY_COL]), "buy_qty")

    if not result:
        raise RuntimeError("거래원 표는 찾았으나 증권사 행이 하나도 없음")

    for entry in result.values():
        entry["net_qty"] = entry["buy_qty"] - entry["sell_qty"]
    return result


def fetch_brokers(ticker: str) -> tuple[dict[str, dict[str, float]], str]:
    """한 종목의 오늘자 상위 창구. (증권사별 매매, 사용한 소스 이름)."""
    errors: list[str] = []
    for name, template in _SOURCES:
        try:
            brokers = parse_brokers(_fetch_html(template.format(code=ticker)))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: {exc}")
            continue
        return brokers, name
    raise RuntimeError(" / ".join(errors))


def build_rows(ticker: str, name: str, as_of: date, close: float | None) -> list[dict]:
    """DB(`broker_trading`)에 넣을 행들. 상위 5개 창구 × 매수/매도."""
    brokers, source = fetch_brokers(ticker)
    return [
        {
            "market": "KR",
            "ticker": ticker,
            "name": name,
            "date": as_of.isoformat(),
            "broker": broker,
            "buy_qty": values["buy_qty"],
            "sell_qty": values["sell_qty"],
            "net_qty": values["net_qty"],
            # 금액은 종가 × 순매수 수량. investor_flow와 같은 근사 방식이다.
            "net_amount": None if not close else values["net_qty"] * close,
            "source": source,
        }
        for broker, values in brokers.items()
    ]


def brokers_match(disclosed: str | None, observed: str | None) -> bool:
    """공시의 위탁증권사 표기와 거래원 표기가 같은 회사인지.

    표기가 완전히 같지 않을 수 있어(공시 '에스케이증권' vs 거래원 'SK증권')
    한쪽이 다른 쪽을 포함하는지로 본다. 공백·'주식회사'는 떼고 비교한다.
    """
    if not disclosed or not observed:
        return False
    def normalize(text: str) -> str:
        return str(text).replace(" ", "").replace("주식회사", "").replace("(주)", "")
    left, right = normalize(disclosed), normalize(observed)
    if not left or not right:
        return False
    return left in right or right in left


def estimate_buyback_progress(
    rows: list[dict],
    broker: str | None,
    period_start: str | None,
    planned_amount: float | None,
) -> dict:
    """위탁 증권사 창구의 누적 순매수로 자사주 매입 진행률을 **추정**한다.

    @param rows `broker_trading`에서 읽은 그 종목의 행들(여러 날짜)
    @param broker 취득결정 공시의 위탁투자중개업자(`cs_iv_bk`)
    @param period_start 취득 예정기간 시작일 — 그 전 거래는 이 프로그램과 무관하다
    """
    matched = [
        r
        for r in rows
        if brokers_match(broker, r.get("broker"))
        and (not period_start or str(r.get("date", "")) >= period_start)
    ]
    # 순매도인 날은 그대로 음수로 더한다 — 매수분만 세면 실제보다 부풀려진다.
    net_qty = sum(float(r.get("net_qty") or 0) for r in matched)
    net_amount = sum(float(r.get("net_amount") or 0) for r in matched)

    progress = None
    if planned_amount and planned_amount > 0 and net_amount > 0:
        progress = min(net_amount / planned_amount * 100, 100.0)

    return {
        "estimated_qty": net_qty,
        "estimated_amount": net_amount,
        "estimated_progress_pct": progress,
        # 며칠치를 실제로 관측했는지. 이게 적으면 추정치를 믿을 근거도 약하다 —
        # 화면이 "N일 관측"으로 같이 보여줘야 사용자가 판단할 수 있다.
        "observed_days": len({r.get("date") for r in matched}),
    }
