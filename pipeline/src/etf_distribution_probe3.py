"""490590 분배금 이력 소스 탐색 프로브 3차 (2026-09-30).

2차(`etf_distribution_probe2.py`)에서 확인된 것:
  · RISE 사이트는 화면을 브라우저에서 그리는 방식(Next.js)이라 표 데이터가 HTML에 없다.
  · `/prod/finderDetail/490590`은 404가 아니라 **400**이었다 — 주소 형식은 맞고 값(RISE 자체
    상품 코드로 보임, 추정)이 틀렸을 가능성.
  · KIND 홈(`mkind.krx.co.kr/`)은 207자짜리 안내만 왔다.

그래서 이번에는:
  A. RISE 홈 HTML에서 **490590 주변 문맥**을 그대로 찍어 RISE 내부 상품 코드를 찾는다.
     (2차의 '490590 포함=True'가 검색어 에코인지 진짜 상품 정보인지도 여기서 가려진다.)
  B. RISE 스크립트 청크(`/_next/static/...js`)에서 **데이터 주소(/api/...)**와 분배 관련 문구를 찾는다.
  C. KIND는 `?method=`를 붙인 PC 입구와, 207자 응답 본문 전체를 본다.

trstk.py에서 배운 것 그대로: 확장자를 전제하지 않는다, 번들의 한글은 `\\uXXXX`라 풀고 찾는다,
천천히 두드린다. 성패를 판정하지 않고 찾은 것을 그대로 찍는다.
"""

from __future__ import annotations

import html
import re
import time
from urllib.parse import urljoin

import requests

ETF_CODE = "490590"
KNOWN_AMOUNT = "188"
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
_API_RELATED = re.compile(r"etf|prod|fund|dist|div|pay|finder|detail|price|nav|분배", re.IGNORECASE)


def _unescape(text: str) -> str:
    """번들·RSC 속 `\\uXXXX`와 `\\"`를 풀어 원문을 만든다. 안 풀면 한글 검색이 영원히 0건이다."""
    text = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), text)
    text = text.replace('\\"', '"').replace("\\/", "/")
    return html.unescape(text)


def _flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def _get(session: requests.Session, url: str, headers: dict | None = None) -> requests.Response | None:
    try:
        return session.get(url, headers={**_UA, **(headers or {})}, timeout=_TIMEOUT)
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ {url}\n    요청 실패: {type(exc).__name__}: {exc}", flush=True)
        return None
    finally:
        time.sleep(_PAUSE)


def probe_rise_home_context(session: requests.Session) -> tuple[str, list[str]]:
    """홈 HTML에서 490590 주변 문맥과 스크립트 청크 목록을 뽑는다."""
    print(f"\n{'═' * 78}\n▶ A. RISE 홈 — {ETF_CODE} 주변 문맥 (RISE 내부 상품 코드 찾기)", flush=True)
    base = "https://www.riseetf.co.kr"
    resp = _get(session, base + "/", {"Referer": base + "/"})
    if resp is None:
        return base, []
    body = _unescape(resp.text)
    print(f"  status={resp.status_code} · {len(resp.text):,}자", flush=True)

    hits = [m.start() for m in re.finditer(ETF_CODE, body)]
    print(f"  '{ETF_CODE}' 등장 {len(hits)}회", flush=True)
    for pos in hits[:4]:
        print(f"    …{_flat(body[max(0, pos - 220): pos + 220])}…", flush=True)

    chunks = sorted(set(re.findall(r"""["'(](/_next/static/[^"'\s)]+\.js[^"'\s)]*)""", resp.text)))
    print(f"  스크립트 청크 {len(chunks)}개", flush=True)
    return base, chunks


def probe_rise_chunks(session: requests.Session, base: str, chunks: list[str]) -> None:
    print(f"\n{'═' * 78}\n▶ B. RISE 스크립트 청크 — 데이터 주소·분배 문구 찾기", flush=True)
    all_api: set[str] = set()
    for src in chunks[:30]:  # 상한 — 많이 쏘면 403이다
        resp = _get(session, urljoin(base + "/", src), {"Referer": base + "/"})
        if resp is None or resp.status_code != 200:
            print(f"  [{src[-60:]}] status={None if resp is None else resp.status_code}", flush=True)
            continue
        body = _unescape(resp.text)
        apis = set(re.findall(r"""["'`]((?:https?://[A-Za-z0-9.\-]+)?/(?:api|prod|etf|fund)[A-Za-z0-9_\-/\.\?=&{}$]*)["'`]""", body))
        related = sorted(a for a in apis if _API_RELATED.search(a))
        kw = [m.start() for m in _KEYWORD.finditer(body)]
        print(f"  [{src[-60:]}] {len(body):,}자 · 관련 주소 {len(related)}개 · 분배 계열 문구 {len(kw)}건", flush=True)
        all_api.update(related)
        for pos in kw[:3]:
            snippet = _flat(body[max(0, pos - 130): pos + 170])
            mark = "  ◀ 188 포함" if KNOWN_AMOUNT in snippet else ""
            print(f"      …{snippet}…{mark}", flush=True)
    print(f"\n  ▷ 종합: 관련 데이터 주소 후보 {len(all_api)}개", flush=True)
    for a in sorted(all_api)[:60]:
        print(f"    · {a}", flush=True)


def probe_kind(session: requests.Session) -> None:
    print(f"\n{'═' * 78}\n▶ C. KRX KIND — 입구 다시 열기", flush=True)

    # 2차에서 207자였던 모바일 홈 본문을 통째로 본다(리다이렉트 안내일 수 있다)
    resp = _get(session, "https://mkind.krx.co.kr/", {"Referer": "https://mkind.krx.co.kr/"})
    if resp is not None:
        print(f"  mkind 홈: status={resp.status_code} · {len(resp.text)}자\n    본문: {_flat(resp.text)[:400]}", flush=True)
        redirects = re.findall(r"""(?:location(?:\.href)?\s*=\s*|url=|href=)["']?([^"'\s>;]+)""", resp.text)
        print(f"    이동 주소 후보: {redirects[:6]}", flush=True)

    # PC KIND는 ?method=를 줘야 열린다 — 없이 부르면 200 + '페이지 오류'가 온다(CLAUDE.md 기록)
    base = "https://kind.krx.co.kr"
    for path in ("/main.do?method=loadInitPage&scrnmode=1", "/common/main.do?method=loadInitPage"):
        resp = _get(session, base + path, {"Referer": base + "/"})
        if resp is None:
            continue
        body = _unescape(resp.text)
        print(f"  [{path}] status={resp.status_code} · {len(body):,}자", flush=True)
        menus = sorted(set(re.findall(r"""["']([^"']*\.do\?method=[A-Za-z0-9_]+[^"']*)["']""", body)))
        related = [m for m in menus if re.search(r"etf|dist|분배|trstk|div", m, re.IGNORECASE)]
        print(f"    메뉴 주소 {len(menus)}개 · 분배·ETF 관련 후보={related[:12]}", flush=True)
        for m in list(_KEYWORD.finditer(body))[:4]:
            print(f"      …{_flat(body[max(0, m.start() - 100): m.end() + 140])}…", flush=True)
        if menus:
            break


def main() -> None:
    session = requests.Session()
    base, chunks = probe_rise_home_context(session)
    if chunks:
        probe_rise_chunks(session, base, chunks)
    probe_kind(session)
    print(
        "\n※ '188 포함'이 붙은 줄이 있으면 그 자리에 실제 분배금이 있는 것이다. "
        "주소 후보만 나왔다면 다음은 그 주소를 실제로 불러 응답 구조를 보는 단계다.",
        flush=True,
    )


if __name__ == "__main__":
    main()
