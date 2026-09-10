"""수급 — 국내 종목의 일별 외국인·기관 순매매.

보물지도에 없던 축이다. 지금까지는 가격·거래량·재무만 봤는데, "떨어지는 동안
외국인이 사고 있었나 팔고 있었나"는 눌림목 판단을 크게 바꾼다.

소스는 네이버다(CLAUDE.md의 "외부 데이터는 네이버부터"). 두 경로를 후보로 두고
앞에서부터 시도한다:

1. `finance.naver.com/item/frgn.naver` — 10년 넘게 같은 형태로 유지돼 온 HTML 표
   (날짜·종가·거래량·기관 순매매량·외국인 순매매량·보유주수·보유율). pandas의
   read_html로 바로 표가 된다. 국내 수급을 키 없이 받을 수 있는 사실상 유일한 곳.
2. `m.stock.naver.com/api/stock/{code}/trend` — 같은 데이터의 JSON 경로로 보이는
   내부 API. 1번이 막히면 자동으로 넘어간다.

한국거래소(KRX) 공식 API도 있지만 인증·요청 제한이 걸려 있고, pykrx는 KRX를
스크레이핑하는 것이라 막히면 같이 죽는다 — 네이버가 더 오래 버텨 왔다.

**단위 주의**: 네이버가 주는 건 순매매 **수량(주)**이지 금액이 아니다. 종가를
곱해 금액도 같이 저장한다 — 화면에서 "몇 억 샀나"로 보는 게 직관적이라서다.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pandas as pd

from .naver_api import HEADERS, TIMEOUT, get_json, rows_from_json, to_number

_FRGN_URL = "https://finance.naver.com/item/frgn.naver"
_TREND_URL = "https://m.stock.naver.com/api/stock/{code}/trend"

# HTML 표는 한 페이지에 20영업일씩 준다. 3페이지면 약 3개월치 — 화면이 보여주는
# 구간(최근 20~60일)에 여유를 둔 값이다. 더 받아봐야 종목당 요청만 늘어난다.
_FRGN_PAGES = 3

# 한 종목이 이만큼도 안 나오면 형식이 바뀐 것으로 보고 다음 소스로 넘어간다.
_MIN_ROWS = 5


def _parse_frgn_table(code: str, page: int) -> pd.DataFrame:
    url = f"{_FRGN_URL}?code={code}&page={page}"
    # read_html은 내부적으로 requests를 쓰지 않아 헤더를 못 넘긴다 — 봇 차단을
    # 피하려면 직접 받아서 문자열로 넘겨야 한다.
    import requests

    resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    # 네이버 금융은 아직 EUC-KR이다. 인코딩을 지정 안 하면 컬럼명이 깨져
    # "외국인"을 못 찾고 조용히 빈 결과가 된다.
    resp.encoding = "euc-kr"

    tables = pd.read_html(resp.text)
    for table in tables:
        cols = ["".join(str(c) for c in col) if isinstance(col, tuple) else str(col) for col in table.columns]
        joined = " ".join(cols)
        if "외국인" in joined and "날짜" in joined:
            table.columns = cols
            return table
    raise RuntimeError(f"외국인·기관 표를 찾지 못함 (표 {len(tables)}개)")


def _column(df: pd.DataFrame, *needles: str) -> str | None:
    for col in df.columns:
        if all(n in col for n in needles):
            return col
    return None


def _from_frgn(code: str) -> list[dict]:
    frames = []
    for page in range(1, _FRGN_PAGES + 1):
        frames.append(_parse_frgn_table(code, page))
    df = pd.concat(frames, ignore_index=True)

    date_col = _column(df, "날짜")
    close_col = _column(df, "종가")
    inst_col = _column(df, "기관", "순매매")
    frgn_col = _column(df, "외국인", "순매매")
    if not (date_col and close_col and inst_col and frgn_col):
        raise RuntimeError(f"필요한 열을 못 찾음: {list(df.columns)}")

    rows: list[dict] = []
    for _, r in df.iterrows():
        raw_date = str(r[date_col]).strip()
        # 빈 행(표 사이 구분선)이 NaN으로 들어온다.
        if not raw_date or raw_date in ("nan", "NaN"):
            continue
        try:
            day = datetime.strptime(raw_date.replace(".", "-"), "%Y-%m-%d").date()
        except ValueError:
            continue
        close = to_number(r[close_col])
        inst = to_number(r[inst_col])
        frgn = to_number(r[frgn_col])
        if close is None or (inst is None and frgn is None):
            continue
        rows.append(
            {
                "date": day.isoformat(),
                "close": close,
                "institution_net_qty": inst,
                "foreign_net_qty": frgn,
            }
        )
    return rows


def _from_trend_api(code: str) -> list[dict]:
    payload = get_json(_TREND_URL.format(code=code))
    raw = rows_from_json(payload)
    rows: list[dict] = []
    for r in raw:
        day = r.get("localTradedAt") or r.get("bizdate") or r.get("date")
        if not day:
            continue
        day = str(day)[:10].replace(".", "-")
        # 20260910 형태로 오는 경우도 있다.
        if len(day) == 8 and day.isdigit():
            day = f"{day[:4]}-{day[4:6]}-{day[6:]}"
        close = to_number(r.get("closePrice") or r.get("close"))
        frgn = to_number(r.get("foreignerPureBuyQuant") or r.get("foreignNetBuy") or r.get("frgnNetBuy"))
        inst = to_number(r.get("organPureBuyQuant") or r.get("institutionNetBuy") or r.get("orgNetBuy"))
        if close is None or (frgn is None and inst is None):
            continue
        rows.append(
            {"date": day, "close": close, "institution_net_qty": inst, "foreign_net_qty": frgn}
        )
    return rows


_SOURCES = (
    ("네이버 금융 외국인·기관 표", _from_frgn),
    ("네이버 모바일 trend API", _from_trend_api),
)


def fetch_investor_flow(ticker: str) -> tuple[list[dict], str]:
    """한 종목의 일별 수급. (행 목록, 사용한 소스 이름)을 돌려준다.

    두 소스 모두 실패하면 마지막 사유를 담은 RuntimeError를 낸다 — 조용히 빈
    목록을 돌려주면 "수급이 0이었다"와 "못 받았다"가 구분이 안 된다.
    """
    errors: list[str] = []
    for name, fetch in _SOURCES:
        try:
            rows = fetch(ticker)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: {exc}")
            continue
        if len(rows) < _MIN_ROWS:
            errors.append(f"{name}: {len(rows)}행뿐 (형식 변경 의심)")
            continue
        return rows, name
    raise RuntimeError(" / ".join(errors))


def build_rows(ticker: str, name: str, days: int = 60) -> list[dict]:
    """DB(`investor_flow`)에 넣을 형태로. 최근 `days`일만 남긴다."""
    raw, source = fetch_investor_flow(ticker)
    cutoff = (date.today() - timedelta(days=days)).isoformat()

    rows: list[dict] = []
    for r in raw:
        if r["date"] < cutoff:
            continue
        close = r["close"]
        frgn_qty = r.get("foreign_net_qty")
        inst_qty = r.get("institution_net_qty")
        rows.append(
            {
                "market": "KR",
                "ticker": ticker,
                "name": name,
                "date": r["date"],
                "close": close,
                "foreign_net_qty": frgn_qty,
                "institution_net_qty": inst_qty,
                # 금액은 종가 × 수량. 장중 평균단가가 아니라 근사치다 — 화면에서
                # "몇 억 규모인가"를 가늠하는 용도라 이 정도면 충분하고, 종가만으로
                # 재현되므로 나중에 검증하기도 쉽다.
                "foreign_net_amount": None if frgn_qty is None else frgn_qty * close,
                "institution_net_amount": None if inst_qty is None else inst_qty * close,
                "source": source,
            }
        )
    # 같은 날짜가 페이지 경계에서 두 번 들어올 수 있다(1페이지와 2페이지가 겹치는
    # 순간에 조회하면). PK 충돌이 아니라 upsert가 조용히 덮어쓰지만, 행 수 로그가
    # 부풀어 진단을 흐리므로 여기서 정리한다.
    seen: set[str] = set()
    unique: list[dict] = []
    for r in sorted(rows, key=lambda x: x["date"], reverse=True):
        if r["date"] in seen:
            continue
        seen.add(r["date"])
        unique.append(r)
    return unique
