"""490590 **분배금 이력** 소스 탐색 프로브 (2026-09-30).

왜 만드나
---------
490590은 월분배 커버드콜 ETF라, 배당락일에 화면 가격이 분배금만큼 빠진다. 사용자가 직접
계산해 보니 9/29 종가는 -125원(-0.88%)이지만 분배금 188원을 빼면 실제로는 +63원(+0.45%)
이었다 — 화면 등락만 보면 손해로 읽히는 것이 실제로는 아니다. 이걸 사이트에서 자동으로
보여주려면 **분배금 이력(배당락일·지급일·주당 금액)**이 필요한데, 소스를 아직 모른다.

CLAUDE.md 원칙대로 네이버부터 두드린다. 성패를 판정하지 않고 (1) 상태 코드, (2) 응답 구조,
(3) 응답 어딘가에 있는 '분배·배당' 관련 키와 값을 그대로 찍는다. "응답이 왔다"와 "맞는
값이다"는 다르므로, 값이 나오면 사용자가 알려 준 실측(2026-09-29 배당락, 주당 188원)과
대조할 수 있도록 188이 들어 있는지도 따로 표시한다.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

import requests

ETF_CODE = "490590"
KNOWN_AMOUNT = 188  # 사용자 실측: 2026-09-29 배당락, 주당 분배금 188원

_UA = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
    ),
}
_TIMEOUT = 20
_KEY_HINT = re.compile(r"divid|distrib|분배|배당|yield|payout|exDate|recordDate", re.IGNORECASE)


def _preview(text: str, limit: int = 500) -> str:
    text = (text or "").strip().replace("\n", " ")
    return text[:limit] + ("..." if len(text) > limit else "")


def _hint_hits(payload: Any, path: str = "") -> list[tuple[str, Any]]:
    """키 이름에 분배·배당 관련 단어가 든 항목을 경로와 함께 모은다(깊이 제한 없음)."""
    hits: list[tuple[str, Any]] = []
    if isinstance(payload, dict):
        for key, value in payload.items():
            here = f"{path}.{key}" if path else str(key)
            if _KEY_HINT.search(str(key)):
                hits.append((here, value))
            hits.extend(_hint_hits(value, here))
    elif isinstance(payload, list):
        for i, item in enumerate(payload[:3]):  # 리스트는 앞 3개면 구조를 알 수 있다
            hits.extend(_hint_hits(item, f"{path}[{i}]"))
    return hits


def _probe_json(session: requests.Session, label: str, url: str, referer: str) -> None:
    print(f"\n{'─' * 78}\n▶ {label}\n  {url}", flush=True)
    try:
        resp = session.get(url, headers={**_UA, "Referer": referer, "Accept": "application/json"}, timeout=_TIMEOUT)
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ 요청 실패: {type(exc).__name__}: {exc}", flush=True)
        return
    print(f"  status={resp.status_code} · {len(resp.text):,}자 · {resp.headers.get('content-type')}", flush=True)
    try:
        payload = resp.json()
    except ValueError:
        print(f"  JSON 아님: {_preview(resp.text, 300)}", flush=True)
        return
    top = list(payload.keys())[:25] if isinstance(payload, dict) else f"list[{len(payload)}]"
    print(f"  최상위: {top}", flush=True)
    hits = _hint_hits(payload)
    if not hits:
        print("  분배·배당 관련 키: 없음", flush=True)
    for path, value in hits[:30]:
        shown = json.dumps(value, ensure_ascii=False)
        mark = "  ◀ 188 포함" if str(KNOWN_AMOUNT) in shown else ""
        print(f"  · {path} = {_preview(shown, 300)}{mark}", flush=True)


def _probe_html(session: requests.Session, label: str, url: str, encoding: str) -> None:
    print(f"\n{'─' * 78}\n▶ {label}\n  {url}", flush=True)
    try:
        resp = session.get(url, headers={**_UA, "Referer": "https://finance.naver.com/"}, timeout=_TIMEOUT)
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ 요청 실패: {type(exc).__name__}: {exc}", flush=True)
        return
    resp.encoding = encoding  # 네이버 금융은 아직 EUC-KR — 안 맞추면 한글이 깨져 아래 검색이 조용히 빈다
    text = resp.text
    print(f"  status={resp.status_code} · {len(text):,}자", flush=True)
    found = 0
    for m in re.finditer(r"분배금|배당|분배율", text):
        start = max(0, m.start() - 80)
        snippet = re.sub(r"\s+", " ", text[start:m.end() + 160])
        mark = "  ◀ 188 포함" if str(KNOWN_AMOUNT) in snippet else ""
        print(f"  · …{snippet}…{mark}", flush=True)
        found += 1
        if found >= 8:
            break
    if not found:
        print("  '분배금/배당/분배율' 문구 없음", flush=True)


def main() -> None:
    session = requests.Session()
    mobile = "https://m.stock.naver.com/"
    api = "https://m.stock.naver.com/api"

    # 이미 구성종목 수집에서 살아 있는 것으로 확인된 경로 — 같은 응답에 분배금이 함께 오는지
    _probe_json(session, "etfAnalysis (구성종목 수집이 쓰는 경로)", f"{api}/stock/{ETF_CODE}/etfAnalysis", mobile)
    time.sleep(1.5)

    # 후보 경로들 — 404면 없는 경로, 400/200이면 있는 경로다(404와 400은 다르다)
    for name in ("integration", "basic", "dividend", "etfDividend", "distribution", "etfBasic", "etfKeyIndicator"):
        _probe_json(session, f"stock/{ETF_CODE}/{name}", f"{api}/stock/{ETF_CODE}/{name}", mobile)
        time.sleep(1.5)

    _probe_json(session, f"etf/{ETF_CODE}/dividend", f"{api}/etf/{ETF_CODE}/dividend", mobile)
    time.sleep(1.5)

    # PC 화면 — 표로 있다면 여기에 '분배금' 문구가 나온다
    _probe_html(session, "PC ETF 종합 (item/main)", f"https://finance.naver.com/item/main.naver?code={ETF_CODE}", "euc-kr")
    time.sleep(1.5)
    _probe_html(session, "PC ETF 분배금 (item/coinfo 탭)", f"https://finance.naver.com/item/coinfo.naver?code={ETF_CODE}", "euc-kr")
    time.sleep(1.5)
    _probe_html(session, "모바일 종목 화면", f"https://m.stock.naver.com/domestic/stock/{ETF_CODE}/total", "utf-8")

    print(
        "\n※ '188 포함' 표시가 붙은 줄이 있으면 그 경로가 실제 분배금을 주는 것이다. "
        "표시가 없는데 숫자만 그럴듯하면 맞는 값이라고 단정하지 말 것.",
        flush=True,
    )


if __name__ == "__main__":
    main()
