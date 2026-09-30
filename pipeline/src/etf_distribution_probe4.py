"""490590 분배금 이력 소스 탐색 프로브 4차 (2026-09-30).

3차(`etf_distribution_probe3.py`) 로그에서 확인된 것:
  · RISE 홈 HTML에 '490590'은 **0회** 나온다 — 2차의 '490590 포함=True'는 검색어가 페이지에
    그대로 찍힌 것이었다(검색이 안 먹는 사이트).
  · RISE 스크립트 청크로 요청한 30개는 전부 **약 141,000자의 홈 화면 HTML**이 돌아왔다.
    즉 데이터 주소는 못 찾았다. 대신 RISE 자체 상품 코드 형태가 보였다:
    `/products/4432`, `/44K1`, `/44K4`, `/44L1` 등 **네 글자 코드**(13개).
    490590이 그중 어느 것인지는 아직 모른다.
  · KIND PC 입구는 `?method=`를 붙이자 **status=200 · 98,717자**로 열렸고 메뉴 92개가 나왔다.
    ETF·배당 관련 후보: `/disclosure/disclosurebystocktype.do?method=searchDisclosureByStockTypeEtf`,
    `/disclosureinfo/dividendinfo.do?method=searchDividendInfoMain`, 공시 유형
    '권리락/배당락/기준가격'(value=0303).

그래서 이번에는:
  A. 3차에서 나온 RISE 상품 코드 13개를 `/prod/finderDetail/{코드}`로 열어, **어느 것이
     490590인지**와 그 페이지에 분배금 표·데이터 주소가 있는지 본다.
  B. KIND ETF 공시 화면과 배당정보 화면을 열어 **검색 조건 이름(input name)과 ajax 주소**를
     그대로 찍는다 — 조건 이름을 모르면 400이 온다(trstk.py 때 겪은 그대로).

성패를 판정하지 않는다. 천천히 두드린다.
"""

from __future__ import annotations

import html
import re
import time

import requests

ETF_CODE = "490590"
KNOWN_AMOUNT = "188"
# 3차 로그에서 그대로 옮긴 RISE 상품 코드 13개 (2026-09-30 실측)
RISE_IDS = [
    "4432", "4435", "4489", "44A7", "44A9", "44B5", "44E4",
    "44G4", "44J2", "44J3", "44K1", "44K4", "44L1",
]
_UA = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9",
}
_TIMEOUT = 25
_PAUSE = 1.2
_KEYWORD = re.compile(r"분배금|분배율|배당락|지급일|distribution|dividend", re.IGNORECASE)


def _unescape(text: str) -> str:
    text = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), text)
    text = text.replace('\\"', '"').replace("\\/", "/")
    return html.unescape(text)


def _flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def _decode(resp: requests.Response) -> str:
    """KIND는 응답 헤더에 문자셋이 없을 때가 있어 requests가 잘못 읽는다(3차 mkind 홈이 깨졌다)."""
    for enc in ("utf-8", "euc-kr"):
        try:
            return resp.content.decode(enc)
        except UnicodeDecodeError:
            continue
    return resp.content.decode("utf-8", errors="replace")


def _get(session: requests.Session, url: str, headers: dict | None = None) -> requests.Response | None:
    try:
        return session.get(url, headers={**_UA, **(headers or {})}, timeout=_TIMEOUT)
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ {url}\n    요청 실패: {type(exc).__name__}: {exc}", flush=True)
        return None
    finally:
        time.sleep(_PAUSE)


def probe_rise_products(session: requests.Session) -> None:
    print(f"\n{'═' * 78}\n▶ A. RISE 상품 코드 13개 — 어느 것이 {ETF_CODE}인가", flush=True)
    base = "https://www.riseetf.co.kr"
    found: list[str] = []
    for pid in RISE_IDS:
        resp = _get(session, f"{base}/prod/finderDetail/{pid}", {"Referer": base + "/"})
        if resp is None:
            continue
        body = _unescape(resp.text)
        title = re.search(r"<title>([^<]*)</title>", body)
        has = ETF_CODE in body
        print(
            f"  [{pid}] status={resp.status_code} · {len(body):,}자 · '{ETF_CODE}' 포함={has}"
            f" · 제목={_flat(title.group(1))[:60] if title else None}",
            flush=True,
        )
        if not has:
            continue
        found.append(pid)
        pos = body.find(ETF_CODE)
        print(f"      ◀ {ETF_CODE} 문맥: …{_flat(body[max(0, pos - 150): pos + 200])}…", flush=True)
        for m in list(_KEYWORD.finditer(body))[:8]:
            s = _flat(body[max(0, m.start() - 110): m.end() + 150])
            mark = "  ◀ 188 포함" if KNOWN_AMOUNT in s else ""
            print(f"      …{s}…{mark}", flush=True)
        apis = sorted(set(re.findall(r"""["'`]((?:https?://[A-Za-z0-9.\-]+)?/(?:api|prod|etf|fund)[A-Za-z0-9_\-/\.\?=&]*)["'`]""", body)))
        print(f"      데이터 주소 후보: {apis[:25]}", flush=True)
    print(f"\n  ▷ 종합: {ETF_CODE}이 들어 있는 상품 코드 = {found or '없음'}", flush=True)


def _kind_screen(session: requests.Session, label: str, path: str) -> None:
    base = "https://kind.krx.co.kr"
    print(f"\n  ── {label}\n     {path}", flush=True)
    # 메인 입구를 먼저 열어 쿠키를 받는다(세션·Referer 정합이 필수인 소스)
    resp = _get(session, base + path, {"Referer": base + "/main.do?method=loadInitPage&scrnmode=1"})
    if resp is None:
        return
    body = _decode(resp)
    print(f"     status={resp.status_code} · {len(body):,}자", flush=True)
    if "페이지 오류" in body[:3000]:
        print("     ✗ '페이지 오류' 안내 — ?method= 조건이 안 맞는 것", flush=True)
        return

    names = sorted(set(re.findall(r"""<(?:input|select|textarea)[^>]*\bname=["']([^"']+)["']""", body, re.IGNORECASE)))
    print(f"     조건 이름(input name) {len(names)}개: {names[:40]}", flush=True)
    ajax = sorted(set(re.findall(r"""["']([^"'\s]*\.do\?method=[A-Za-z0-9_]+[^"'\s]*)["']""", body)))
    ajax = [a for a in ajax if re.search(r"search|list|etf|div|dist|sub", a, re.IGNORECASE)]
    print(f"     .do 주소 후보 {len(ajax)}개: {ajax[:25]}", flush=True)
    for m in list(_KEYWORD.finditer(body))[:5]:
        s = _flat(body[max(0, m.start() - 90): m.end() + 130])
        mark = "  ◀ 188 포함" if KNOWN_AMOUNT in s else ""
        print(f"     …{s}…{mark}", flush=True)


def probe_kind(session: requests.Session) -> None:
    print(f"\n{'═' * 78}\n▶ B. KRX KIND — ETF 공시·배당정보 화면의 조건 이름과 주소", flush=True)
    base = "https://kind.krx.co.kr"
    warm = _get(session, base + "/main.do?method=loadInitPage&scrnmode=1", {"Referer": base + "/"})
    if warm is not None:
        print(f"  세션 준비: status={warm.status_code} · 쿠키 {len(session.cookies)}개", flush=True)
    _kind_screen(session, "ETF 공시", "/disclosure/disclosurebystocktype.do?method=searchDisclosureByStockTypeEtf")
    _kind_screen(session, "배당정보", "/disclosureinfo/dividendinfo.do?method=searchDividendInfoMain")


def main() -> None:
    session = requests.Session()
    probe_rise_products(session)
    probe_kind(session)
    print(
        "\n※ '188 포함'이 붙은 줄이 있으면 그 자리에 실제 분배금이 있는 것이다. "
        "조건 이름·주소가 나왔다면 다음은 그것으로 490590을 검색해 응답을 보는 단계다.",
        flush=True,
    )


if __name__ == "__main__":
    main()
