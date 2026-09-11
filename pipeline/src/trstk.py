"""KRX KIND **자기주식 매매 체결내역** 수집 — 자사주 진행률의 확정 근거.

`/api/trstk/traded`가 종목별·일자별 **신청수량과 체결수량**을 그대로 준다.
이것이 자사주 진행률의 세 근거 중 가장 강한 ①번이 된다.

## 왜 이게 필요했나

`buyback.py`가 쓰는 DART 주요사항보고서는 **"얼마를 사겠다"는 계획 공시**다. 실제
체결량은 결과보고서에만 있는데 그건 프로그램이 **끝난 뒤** 나온다. 그래서 진행
중인 3~6개월간은 아무것도 알 수 없었고, 화면은 기간 경과율(달력)밖에 못 보여줬다.

`broker_flow.py`의 창구 추정은 그 공백을 메우려는 차선책이었다 — 과거 소급이 안 되고
남의 주문이 섞이는 **추정치**다. 이 모듈이 그걸 대체한다: **확정치이고 소급도 된다.**

## 경로를 찾기까지 (2026-09-11, 같은 실수 반복 방지용)

1. **확장자를 전제하지 말 것.** `.do`만, 다음엔 `.do|.js|.json|.cmd`로 넓혀도 0건이었다.
   확장자를 아예 버리자 `/api/...`가 나왔다.
2. **PC KIND는 `?method=`를 줘야 열린다.** 맨손으로 부르면 404가 아니라 200 + "페이지
   오류" 안내라서 "막혔다"고 오해하기 쉽다. 사용자가 준 뷰어 주소가 이걸 알려줬다.
3. **400과 404는 전혀 다르다.** 틀린 주소는 404+HTML, 맞는 주소는 400+JSON
   (`"파라미터 검증 실패"`)이다. 400을 받았다면 **주소는 맞은 것**이다.
4. **번들의 한글은 `\\uXXXX`로 이스케이프돼 있다.** 원문으로 '자기주식'을 찾으면 0건이다.
5. **천천히 두드릴 것.** 한 실행에서 130여 회를 쏘고 403을 맞았다. 세션(쿠키) + 요청
   간격 + Referer 정합이 필요하다.

## 주의

- 화면 소스가 쓰는 조건 이름 그대로 보낸다: `marketType`·`corpName`·`repIsuSrtCd`·
  `fromDate`·`toDate`·`pageNo`. 날짜는 **대시 없는 `YYYYMMDD`**(실측 확정).
- 응답 `dataList`의 각 행에 `tot_cnt`가 들어 있다 — 전체 건수라 페이지 반복의 종료
  조건으로 쓴다. 별도 total 필드가 아니라 **행 안에** 있다는 점에 주의.
- `trstk_acqstdisp_tp_cd`: 1=취득, 2=처분, 0=신탁. **취득만 더해야** 진행률이 맞다.
"""

from __future__ import annotations

import time
from datetime import date

import requests

_BASE = "https://mkind.krx.co.kr"
_API = f"{_BASE}/api/trstk/traded"
_PAGE_URL = f"{_BASE}/trstk-traded"

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)

# 403을 한 번 맞아 봤다. 사람이 쓰는 속도를 흉내낸다.
PAUSE_SECONDS = 2.0
MAX_PAGES = 20
TIMEOUT = 25

ACQUIRE_CODE = "1"


class TrstkError(RuntimeError):
    """수집 실패. 사유가 로그에 그대로 드러나도록 메시지에 담는다."""


def open_session() -> requests.Session:
    """쿠키를 받아 둔 세션. 화면을 한 번 거쳐야 조회가 통한다."""
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": _UA,
            "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
            "Connection": "keep-alive",
        }
    )
    session.get(f"{_BASE}/main", headers={"Referer": "https://www.google.com/"}, timeout=TIMEOUT)
    time.sleep(PAUSE_SECONDS)
    session.get(_PAGE_URL, headers={"Referer": f"{_BASE}/main"}, timeout=TIMEOUT)
    return session


def _fetch_page(session: requests.Session, ticker: str, name: str, start: str, end: str, page: int) -> list[dict]:
    time.sleep(PAUSE_SECONDS)
    params = {
        "marketType": "",
        "corpName": name,
        "repIsuSrtCd": ticker,
        "fromDate": start,
        "toDate": end,
        "pageNo": page,
    }
    resp = session.get(
        _API,
        params=params,
        headers={
            "Referer": _PAGE_URL,
            "Accept": "application/json, text/plain, */*",
            "X-Requested-With": "XMLHttpRequest",
        },
        timeout=TIMEOUT,
    )
    if resp.status_code == 403:
        raise TrstkError(f"{ticker}: 403 — 요청이 잦아 차단됐다(간격을 늘릴 것)")
    try:
        payload = resp.json()
    except ValueError as exc:  # noqa: BLE001
        raise TrstkError(f"{ticker}: JSON이 아닌 응답 {resp.status_code} ({len(resp.text or ''):,}자)") from exc

    if not payload.get("resultOk"):
        # 400은 "주소가 틀렸다"가 아니라 "조건이 틀렸다"는 뜻이다. 사유를 그대로 올린다.
        raise TrstkError(
            f"{ticker}: {resp.status_code} {payload.get('resultCode')} {payload.get('message')!r}"
        )
    return payload.get("dataList") or []


def fetch_trades(ticker: str, name: str, start: date, end: date, session: requests.Session | None = None) -> list[dict]:
    """기간 내 **취득** 체결 행을 날짜 오름차순으로. 없으면 빈 목록."""
    own = session is None
    session = session or open_session()
    start_s, end_s = start.strftime("%Y%m%d"), end.strftime("%Y%m%d")

    rows: list[dict] = []
    total: int | None = None
    for page in range(1, MAX_PAGES + 1):
        chunk = _fetch_page(session, ticker, name, start_s, end_s, page)
        if not chunk:
            break
        # 전체 건수가 응답 본문이 아니라 **각 행 안에** 들어 있다.
        if total is None:
            total = int(chunk[0].get("tot_cnt") or 0)
        rows.extend(chunk)
        if total and len(rows) >= total:
            break

    if own:
        session.close()

    out: list[dict] = []
    for row in rows:
        if str(row.get("trstk_acqstdisp_tp_cd")) != ACQUIRE_CODE:
            continue
        trd_dd = str(row.get("trd_dd") or "")
        if len(trd_dd) != 8:
            continue
        out.append(
            {
                "market": "KR",
                "ticker": ticker,
                "name": row.get("com_abbrv") or name,
                "date": f"{trd_dd[:4]}-{trd_dd[4:6]}-{trd_dd[6:]}",
                "applied_qty": _to_int(row.get("trstk_appl_qty")),
                "traded_qty": _to_int(row.get("trstk_trd_qty")),
                "source": "KIND trstk/traded",
            }
        )
    out.sort(key=lambda r: r["date"])
    return out


def _to_int(value) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(str(value).replace(",", ""))
    except ValueError:
        return None


def summarize(trades: list[dict], planned_qty: float | None) -> dict:
    """누적 체결량과 진행률. 계획 수량을 모르면 진행률은 None."""
    qty = sum(t["traded_qty"] or 0 for t in trades)
    pct = None
    if planned_qty and planned_qty > 0 and qty > 0:
        # 계획을 넘겨 사는 일은 없지만, 정정 공시로 계획이 줄면 100%를 넘을 수 있다.
        pct = min(qty / float(planned_qty) * 100.0, 100.0)
    return {
        "confirmed_qty": qty or None,
        "confirmed_progress_pct": pct,
        "confirmed_days": len(trades) or None,
        "confirmed_through": trades[-1]["date"] if trades else None,
    }
