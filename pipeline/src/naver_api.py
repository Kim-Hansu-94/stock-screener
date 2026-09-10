"""네이버 증권 내부 API 공통 헬퍼.

`universe_us.py`가 Russell 3000을 네이버에서 받아오며 겪은 실패 방식이 그대로
여기에도 적용된다 — 봇 차단 페이지가 HTTP 200 + HTML로 오고, 응답을 감싸는 키
이름(data / result / stockList ...)이 예고 없이 바뀐다. 그래서 (1) JSON이 아니면
사유가 드러나는 에러로 바꾸고, (2) 키를 고정하지 않고 구조로 찾는다.

universe_us.py에 같은 함수가 있지만 그쪽은 손대지 않았다 — 유니버스 수집은
매일 도는 본 파이프라인의 첫 단계라, 새 기능을 위해 리팩터링하다 깨지면
스크리닝 전체가 멈춘다. 새 모듈만 이 파일을 쓴다.
"""

from __future__ import annotations

from typing import Any

import requests

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
    ),
    "Referer": "https://m.stock.naver.com/",
    "Accept": "application/json, text/plain, */*",
}

TIMEOUT = 20


def body_snippet(resp: requests.Response, limit: int = 200) -> str:
    text = (resp.text or "").strip().replace("\n", " ")
    return text[:limit] + ("..." if len(text) > limit else "")


def require_json(resp: requests.Response) -> Any:
    """JSON이 아닌 응답을 사유가 드러나는 에러로 바꾼다.

    봇 차단 페이지는 200 + HTML로 오기 때문에 raise_for_status()를 통과한다.
    그대로 .json()을 부르면 'Expecting value: line 1 column 1'만 남아 로그를 봐도
    왜 실패했는지 알 수 없다.
    """
    try:
        return resp.json()
    except ValueError:
        raise RuntimeError(
            f"JSON이 아닌 응답 (content-type={resp.headers.get('content-type')}): {body_snippet(resp)}"
        ) from None


def get_json(url: str, params: dict | None = None) -> Any:
    resp = requests.get(url, params=params, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    return require_json(resp)


def rows_from_json(payload: Any) -> list[dict]:
    """응답 어딘가에 있는 '딕셔너리들의 리스트' 중 가장 긴 것을 찾아 돌려준다.

    감싸는 키 이름을 고정하면 그 이름이 바뀔 때 조용히 빈 결과가 된다.
    """
    if isinstance(payload, list):
        return [r for r in payload if isinstance(r, dict)]
    if isinstance(payload, dict):
        best: list[dict] = []
        for value in payload.values():
            rows = rows_from_json(value)
            if len(rows) > len(best):
                best = rows
        return best
    return []


def find_first(payload: Any, keys: tuple[str, ...]) -> Any:
    """중첩된 응답 어디에 있든 후보 키 중 처음 만나는 값을 돌려준다.

    컨센서스처럼 "값 하나"를 뽑을 때 쓴다. 경로(a.b.c)를 고정하면 네이버가 응답을
    한 겹 더 감싸는 순간 조용히 None이 된다.
    """
    if isinstance(payload, dict):
        for key in keys:
            if key in payload and payload[key] not in (None, "", "-"):
                return payload[key]
        for value in payload.values():
            found = find_first(value, keys)
            if found is not None:
                return found
    elif isinstance(payload, list):
        for item in payload:
            found = find_first(item, keys)
            if found is not None:
                return found
    return None


def to_number(value: Any) -> float | None:
    """'1,234' · '+1,234' · '12.3%' 같은 표기를 숫자로. 못 바꾸면 None."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "").replace("%", "").replace("+", "")
    if text in ("", "-", "--", "N/A"):
        return None
    try:
        return float(text)
    except ValueError:
        return None
