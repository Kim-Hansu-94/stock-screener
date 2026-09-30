"""490590 분배금 이력 소스 탐색 프로브 2차 — 운용사(KB자산운용 RISE)와 KRX KIND (2026-09-30).

1차(`etf_distribution_probe.py`) 결과: 네이버는 요약값(최근 1년 합계·올해 횟수·연 분배율)만
주고 회차별 배당락일·지급일·금액이 없다. 그래서 원본에 가까운 두 곳을 본다.

  · RISE ETF 사이트(운용사) — 상품 페이지에 '분배금 지급 내역' 표가 있을 가능성.
  · KRX KIND — 거래소 공시. 주소·조건을 모르므로 화면 번들에서 '분배' 관련 API를 찾는다.

주소를 미리 모르기 때문에 **사이트 안에서 실제 링크·스크립트를 따라가며** 찾는다.
trstk.py에서 배운 것을 그대로 적용한다: 확장자를 전제하지 않는다, 번들의 한글은 `\\uXXXX`
이스케이프라 풀고 찾는다, **천천히** 두드린다(한 실행에 130회를 쏴서 403을 맞은 전례).
성패를 판정하지 않고 찾은 것을 그대로 찍는다.
"""

from __future__ import annotations

import html
import re
import time
from urllib.parse import urljoin

import requests

ETF_CODE = "490590"
KNOWN_AMOUNT = "188"  # 사용자 실측: 2026-09-29 배당락, 주당 분배금 188원
_UA = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9",
}
_TIMEOUT = 25
_PAUSE = 1.5
_KEYWORD = re.compile(r"분배금|분배율|배당락|지급일|distribution", re.IGNORECASE)


def _unescape(text: str) -> str:
    """번들 속 `\\uXXXX`를 한글로 되돌린다. 안 풀면 '분배금'으로 영원히 못 찾는다."""
    text = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), text)
    return html.unescape(text)


def _snippets(text: str, limit: int = 6, width: int = 110) -> list[str]:
    out: list[str] = []
    for m in _KEYWORD.finditer(text):
        s = re.sub(r"\s+", " ", text[max(0, m.start() - width): m.end() + width])
        mark = "  ◀ 188 포함" if KNOWN_AMOUNT in s else ""
        out.append(f"…{s}…{mark}")
        if len(out) >= limit:
            break
    return out


def _get(session: requests.Session, url: str, **kw) -> requests.Response | None:
    try:
        resp = session.get(url, headers={**_UA, **kw.pop("headers", {})}, timeout=_TIMEOUT, **kw)
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ {url}\n    요청 실패: {type(exc).__name__}: {exc}", flush=True)
        return None
    finally:
        time.sleep(_PAUSE)
    return resp


def probe_rise(session: requests.Session) -> None:
    print(f"\n{'═' * 78}\n▶ RISE ETF (KB자산운용) 사이트", flush=True)
    base = "https://www.riseetf.co.kr"
    home = _get(session, base + "/")
    if home is None:
        return
    print(f"  홈: status={home.status_code} · {len(home.text):,}자", flush=True)
    text = home.text

    # 490590이나 상품 상세 링크가 홈 어딘가에 있는지
    detail_links = sorted(set(re.findall(r"""["'](/prod/[^"'\s]*(?:finderDetail|detail)[^"'\s]*)["']""", text)))
    print(f"  상품 상세 링크 후보 {len(detail_links)}개: {detail_links[:8]}", flush=True)
    for m in list(re.finditer(ETF_CODE, text))[:3]:
        print(f"  · 홈에서 {ETF_CODE} 발견: …{re.sub(chr(10), ' ', text[max(0, m.start() - 100): m.end() + 100])}…", flush=True)

    # 종목 검색·목록 후보 — 어떤 게 열리는지 상태 코드로 본다(404와 200/400은 다르다)
    candidates = [
        f"/prod/finderList?search={ETF_CODE}",
        f"/prod/finder?keyword={ETF_CODE}",
        f"/search?keyword={ETF_CODE}",
        f"/prod/finderDetail/{ETF_CODE}",
    ]
    seen_detail: list[str] = []
    for path in candidates:
        resp = _get(session, base + path, headers={"Referer": base + "/"})
        if resp is None:
            continue
        body = resp.text
        found = sorted(set(re.findall(r"""["'](/prod/finderDetail/[^"'\s?#]+)""", body)))
        has = ETF_CODE in body
        print(f"  [{path}] status={resp.status_code} · {len(body):,}자 · '{ETF_CODE}' 포함={has} · 상세링크={found[:5]}", flush=True)
        for s in _snippets(_unescape(body), limit=3):
            print(f"      {s}", flush=True)
        seen_detail.extend(found)

    # 찾은 상세 링크 중 490590과 이어질 만한 것 — 페이지 안에 490590이 있으면 그게 답이다
    for path in sorted(set(seen_detail))[:6]:
        resp = _get(session, base + path, headers={"Referer": base + "/"})
        if resp is None:
            continue
        body = resp.text
        print(f"  [상세 {path}] status={resp.status_code} · {len(body):,}자 · '{ETF_CODE}' 포함={ETF_CODE in body}", flush=True)
        if ETF_CODE in body:
            for s in _snippets(_unescape(body), limit=8):
                print(f"      {s}", flush=True)
            # 표를 ajax로 채운다면 그 주소가 인라인 스크립트에 있다
            ajax = sorted(set(re.findall(r"""["'](/[A-Za-z0-9_/\-]*(?:ajax|api|json|list|dist|div)[A-Za-z0-9_/\-\.]*)["']""", body)))
            print(f"      ajax/api 주소 후보: {ajax[:15]}", flush=True)


def probe_kind(session: requests.Session) -> None:
    print(f"\n{'═' * 78}\n▶ KRX KIND — 화면 번들에서 '분배' 관련 API 찾기", flush=True)
    base = "https://mkind.krx.co.kr"
    home = _get(session, base + "/", headers={"Referer": base + "/"})
    if home is None:
        return
    print(f"  홈: status={home.status_code} · {len(home.text):,}자", flush=True)
    scripts = sorted(set(re.findall(r"""src=["']([^"']+\.js[^"']*)["']""", home.text)))
    print(f"  스크립트 {len(scripts)}개", flush=True)

    hits = 0
    for src in scripts[:12]:  # 상한 — 많이 쏘면 403이다
        url = urljoin(base + "/", src)
        resp = _get(session, url, headers={"Referer": base + "/"})
        if resp is None or resp.status_code != 200:
            print(f"  [{src}] status={None if resp is None else resp.status_code}", flush=True)
            continue
        body = _unescape(resp.text)
        kw = _snippets(body, limit=4, width=140)
        apis = sorted(set(re.findall(r"""["'](/api/[A-Za-z0-9_\-/]+)["']""", body)))
        related = [a for a in apis if re.search(r"etf|dist|div|pay|분배", a, re.IGNORECASE)]
        print(f"  [{src}] {len(body):,}자 · '분배' 계열 문구 {len(kw)}건 · /api 주소 {len(apis)}개 · 관련 후보={related}", flush=True)
        for s in kw:
            print(f"      {s}", flush=True)
            hits += 1
    if not hits:
        print("  '분배금/분배율/배당락/지급일' 문구가 번들에서 나오지 않음 (KIND 화면에 있더라도 다른 번들일 수 있다)", flush=True)


def main() -> None:
    session = requests.Session()
    probe_rise(session)
    probe_kind(session)
    print(
        "\n※ '188 포함'이 붙은 줄이 있으면 그 페이지에 실제 분배금이 있는 것이다. "
        "'490590 포함=True'인데 188이 없으면 표가 ajax로 따로 오는 것이므로 위 ajax 후보를 다음 프로브 대상으로 삼는다.",
        flush=True,
    )


if __name__ == "__main__":
    main()
