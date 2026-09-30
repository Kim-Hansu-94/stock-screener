"""490590 분배금 이력 소스 탐색 프로브 5차 (2026-09-30).

4차(`etf_distribution_probe4.py`) 로그에서 확인된 것:
  · RISE 상품 코드 13개는 전부 다른 상품이었다(490590 없음). RISE 방향은 접는다.
  · KIND ETF 공시 화면 `/disclosure/disclosurebystocktype.do?method=searchDisclosureByStockTypeEtf`는
    status=200 · 74,157자로 열렸고 검색 조건 이름이 나왔다:
    `etfIsuSrtCd`, `etfIsuSrtNm`, `fromDate`, `toDate`, `reportCd`, `reportNm`, `pageIndex`,
    `currentPageSize`, `method`, `searchCodeType`, `orderMode`, `orderStat`, `forward` ...

이번에는 그 조건으로 **490590을 실제로 검색**한다.

조건 이름만 알고 값을 틀리면 400이 온다(trstk.py 때 겪은 그대로: 400이면 주소는 맞고 조건이
틀린 것). 그래서 조건을 손으로 짜지 않고, **화면이 원래 보내는 값(숨은 입력 포함)을 그대로
읽어서 필요한 것만 덮어쓴다.** 목록을 가져오는 실제 주소는 화면 스크립트 안에 있으므로
(`...Sub`류) 거기서 찾고, 못 찾으면 후보를 순서대로 시도한다.

성패를 판정하지 않는다. 받은 표 행과 공시 제목을 그대로 찍는다. 천천히 두드린다.
"""

from __future__ import annotations

import html
import re
import time

import requests

ETF_CODE = "490590"
ETF_NAME = "RISE 미국AI밸류체인데일리고정커버드콜"
KNOWN_AMOUNT = "188"
BASE = "https://kind.krx.co.kr"
PAGE = "/disclosure/disclosurebystocktype.do"
ENTRY = "/main.do?method=loadInitPage&scrnmode=1"
FROM_DATE = "2026-01-01"
TO_DATE = "2026-09-30"
_UA = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9",
}
_TIMEOUT = 25
_PAUSE = 1.5
_KEYWORD = re.compile(r"분배금|분배율|배당락|기준가격|지급")


def _decode(resp: requests.Response) -> str:
    for enc in ("utf-8", "euc-kr"):
        try:
            return resp.content.decode(enc)
        except UnicodeDecodeError:
            continue
    return resp.content.decode("utf-8", errors="replace")


def _flat(text: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", text))).strip()


def _get(session: requests.Session, path: str, referer: str) -> requests.Response | None:
    try:
        return session.get(BASE + path, headers={**_UA, "Referer": BASE + referer}, timeout=_TIMEOUT)
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ GET {path}\n    요청 실패: {type(exc).__name__}: {exc}", flush=True)
        return None
    finally:
        time.sleep(_PAUSE)


def _post(session: requests.Session, path: str, data: dict, referer: str) -> requests.Response | None:
    try:
        return session.post(
            BASE + path,
            data=data,
            headers={**_UA, "Referer": BASE + referer, "X-Requested-With": "XMLHttpRequest"},
            timeout=_TIMEOUT,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ POST {path}\n    요청 실패: {type(exc).__name__}: {exc}", flush=True)
        return None
    finally:
        time.sleep(_PAUSE)


def _form_defaults(body: str) -> dict[str, str]:
    """화면의 <input>/<select>가 원래 담고 있는 값. 이름만 알고 값을 틀리면 400이 온다."""
    out: dict[str, str] = {}
    for tag in re.findall(r"<input\b[^>]*>", body, re.IGNORECASE):
        name = re.search(r"""\bname=["']([^"']+)["']""", tag)
        if not name:
            continue
        kind = (re.search(r"""\btype=["']([^"']+)["']""", tag) or [None, "text"])[1].lower()
        if kind in ("checkbox", "radio", "button", "submit", "image") and "checked" not in tag.lower():
            continue
        value = re.search(r"""\bvalue=["']([^"']*)["']""", tag)
        out[name.group(1)] = html.unescape(value.group(1)) if value else ""
    return out


def _sub_methods(body: str) -> list[str]:
    """화면 스크립트에서 목록을 가져오는 method 이름을 찾는다(대개 ...Sub)."""
    found = re.findall(r"""method=([A-Za-z0-9_]*(?:Etf)[A-Za-z0-9_]*)""", body)
    ordered: list[str] = []
    for m in found:
        if m not in ordered:
            ordered.append(m)
    return ordered


def _rows(body: str) -> list[str]:
    rows = re.findall(r"<tr\b[^>]*>(.*?)</tr>", body, re.IGNORECASE | re.DOTALL)
    return [_flat(r) for r in rows if _flat(r)]


def _report(label: str, resp: requests.Response | None) -> str | None:
    """응답을 요약해서 찍고, 표가 왔으면 본문을 돌려준다."""
    if resp is None:
        return None
    body = _decode(resp)
    print(f"    [{label}] status={resp.status_code} · {len(body):,}자", flush=True)
    if resp.status_code != 200:
        print(f"      본문: {_flat(body)[:240]}", flush=True)
        return None
    if "페이지 오류" in body[:3000]:
        print("      ✗ '페이지 오류' 안내", flush=True)
        return None
    rows = _rows(body)
    has_code = ETF_CODE in body
    print(f"      표 행 {len(rows)}개 · '{ETF_CODE}' 포함={has_code}", flush=True)
    for r in rows[:14]:
        mark = "  ◀ 188 포함" if KNOWN_AMOUNT in r else ""
        print(f"      · {r[:170]}{mark}", flush=True)
    if not rows:
        print(f"      본문 앞부분: {_flat(body)[:300]}", flush=True)
    return body


def main() -> None:
    session = requests.Session()
    print(f"{'═' * 78}\n▶ KIND ETF 공시 — {ETF_CODE} 검색", flush=True)

    warm = _get(session, ENTRY, "/")
    print(f"  세션 준비: status={None if warm is None else warm.status_code} · 쿠키 {len(session.cookies)}개", flush=True)

    page_path = f"{PAGE}?method=searchDisclosureByStockTypeEtf"
    page = _get(session, page_path, ENTRY)
    if page is None or page.status_code != 200:
        print("  ✗ ETF 공시 화면을 못 열었다 — 중단", flush=True)
        return
    body = _decode(page)
    defaults = _form_defaults(body)
    subs = _sub_methods(body)
    print(f"  화면 status=200 · {len(body):,}자", flush=True)
    print(f"  화면이 원래 담은 입력값 {len(defaults)}개: {defaults}", flush=True)
    print(f"  화면 안의 Etf 관련 method 이름: {subs}", flush=True)

    # 화면 값 위에 검색 조건만 덮어쓴다
    base_data = {
        **defaults,
        "etfIsuSrtCd": ETF_CODE,
        "etfIsuSrtNm": ETF_NAME,
        "repIsuSrtCd": ETF_CODE,
        "fromDate": FROM_DATE,
        "toDate": TO_DATE,
        "pageIndex": "1",
        "currentPageSize": "100",
    }

    # 목록을 주는 method 후보 — 화면에서 찾은 것 먼저, 관례상 흔한 이름을 뒤에
    candidates: list[str] = []
    for m in [*subs, "searchDisclosureByStockTypeEtfSub", "searchDisclosureByStockTypeEtfList"]:
        if m not in candidates:
            candidates.append(m)

    good: str | None = None
    for m in candidates[:6]:
        print(f"\n  ── method={m}", flush=True)
        body_ok = _report("공시 전체", _post(session, PAGE, {**base_data, "method": m}, page_path))
        # 화면 자체(검색창)가 그대로 돌아온 것은 검색 결과가 아니다 — 처음 실행에서 이걸 성공으로
        # 세는 바람에 검색창 글자('종목명 찾기', '기간 ~')를 표로 오판했다(2026-09-30).
        if body_ok is not None and len(body_ok) != len(body) and (_rows(body_ok) or ETF_CODE in body_ok):
            good = m
            break

    if good is None:
        print("\n  ▷ 종합: 표를 돌려주는 method를 못 찾았다 — 위 status·본문 앞부분이 다음 단서", flush=True)
        return

    print(f"\n  ▷ 표를 돌려준 method = {good}", flush=True)

    # 배당락/기준가격 공시만 (2026-09-30 4차: 공시 유형 '권리락/배당락/기준가격' 값 0303|)
    print("\n  ── 같은 method, 공시 유형을 '권리락/배당락/기준가격'으로 좁힘", flush=True)
    body2 = _report(
        "배당락/기준가격",
        _post(session, PAGE, {**base_data, "method": good, "reportCd": "0303|", "reportNm": "권리락/배당락/기준가격"}, page_path),
    )
    text = body2 or ""
    acpt = re.findall(r"""(?:openDisclsViewer|acptNo|acptno)[^0-9]{0,12}(\d{14})""", text)
    print(f"\n  ▷ 접수번호(공시 본문을 여는 열쇠) 후보: {acpt[:6]}", flush=True)

    # 첫 공시 뷰어 한 번만 — 금액이 목록이 아니라 본문에 있는지 본다
    if acpt:
        acptno = acpt[0]
        viewer = f"/common/disclsviewer.do?method=search&acptno={acptno}&docno=&viewerhost=&viewerport="
        print(f"\n  ── 공시 뷰어 {acptno}", flush=True)
        resp = _get(session, viewer, page_path)
        if resp is not None:
            vb = _decode(resp)
            print(f"    status={resp.status_code} · {len(vb):,}자", flush=True)
            docs = sorted(set(re.findall(r"""["']([^"']*\.(?:htm|html)[^"']*)["']""", vb)))
            print(f"    본문 문서 주소 후보: {docs[:6]}", flush=True)
            for m in list(_KEYWORD.finditer(vb))[:6]:
                s = _flat(vb[max(0, m.start() - 100): m.end() + 140])
                mark = "  ◀ 188 포함" if KNOWN_AMOUNT in s else ""
                print(f"      …{s}…{mark}", flush=True)

    print(
        "\n※ '188 포함'이 붙은 줄이 있으면 그 자리에 실제 분배금이 있는 것이다. "
        "표는 오는데 188이 없다면 금액은 공시 본문에만 있는 것이므로 다음은 본문 문서를 여는 단계다.",
        flush=True,
    )


if __name__ == "__main__":
    main()
