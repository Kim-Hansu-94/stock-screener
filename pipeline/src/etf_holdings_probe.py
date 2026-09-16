"""490590 구성종목·비중 소스 **탐색** 프로브.

목적은 "살아 있나"가 아니라 **"어떤 모양으로 오나"**다 — buyback_probe.py와 같은 원칙으로
성패를 판정하지 않고 응답 구조를 그대로 찍는다. 후보 경로를 위에서부터 두드리고, 되는
경로가 나오면 그 JSON 키 이름을 눈으로 보고 수집기를 짜면 된다.

왜 필요한가 (2026-09-16 사용자 제안)
------------------------------------
지금 `frontend/lib/etfEntryCheck.ts`는 대장주 5개(오라클·알파벳·엔비디아·AMD·마벨)를
**코드에 하드코딩**하고 **전부 동등하게** 센다("5개 중 3개 상승 전환"). 사용자가 직접
고른 목록이라 그 자체는 의도한 것이지만, 두 가지를 우리가 모른다:

  1. 이 5개가 실제 490590 구성 상위와 맞는가
  2. 실제 비중이 얼마인가 (비중대로 가중하면 신호가 더 정확해질 수 있다)

**추측으로 채우면 안 된다.** CLAUDE.md의 보고 규칙 — 프로브 출력에 값이 실제로 찍혔을
때만 "확인됐다"고 말한다. 그래서 먼저 이 프로브로 어디서 무엇이 오는지부터 본다.

네이버부터 두드리는 이유는 CLAUDE.md의 기본 원칙이다(국내 관점 데이터에 가장 강하고,
이 저장소에서 가장 잘 버텨온 소스). 네이버가 안 되면 KRX·운용사 순으로 내려간다.

실행: .github/workflows/etf_holdings_probe.yml (작업 컨테이너는 네이버·KRX가 막혀 있다)
"""

from __future__ import annotations

import json
from typing import Any

import requests

from .naver_api import HEADERS, TIMEOUT, body_snippet

ETF_CODE = "490590"

# 위에서부터 두드린다. 어느 것이 살아 있는지 모르므로 **판정하지 않고 구조만 찍는다.**
_CANDIDATES: list[tuple[str, str, dict[str, Any] | None]] = [
    ("네이버 모바일 ETF 분석", f"https://m.stock.naver.com/api/stock/{ETF_CODE}/etfAnalysis", None),
    ("네이버 모바일 종목 기본", f"https://m.stock.naver.com/api/stock/{ETF_CODE}/basic", None),
    ("네이버 증권 ETF 구성종목", f"https://api.stock.naver.com/etf/{ETF_CODE}/constituents", None),
    ("네이버 증권 ETF 상세", f"https://api.stock.naver.com/etf/{ETF_CODE}", None),
    ("네이버 증권 종목 통합", f"https://api.stock.naver.com/stock/{ETF_CODE}/integration", None),
    (
        "KRX 정보데이터시스템 ETF PDF(구성종목)",
        "https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd",
        {
            "bld": "dbms/MDC/STAT/standard/MDCSTAT05001",
            "isuCd": ETF_CODE,
            "trdDd": "",
            "share": "1",
            "money": "1",
        },
    ),
]


def _walk_keys(payload: Any, prefix: str = "", depth: int = 0, out: list[str] | None = None) -> list[str]:
    """응답의 키 구조를 납작하게 편다 — 감싸는 키 이름이 예고 없이 바뀌는 소스라,
    값보다 **어떤 키가 있는지**가 먼저 필요하다."""
    if out is None:
        out = []
    if depth > 3 or len(out) > 60:
        return out
    if isinstance(payload, dict):
        for key, value in payload.items():
            path = f"{prefix}.{key}" if prefix else key
            if isinstance(value, (dict, list)):
                out.append(f"{path} ({type(value).__name__})")
                _walk_keys(value, path, depth + 1, out)
            else:
                out.append(f"{path} = {str(value)[:60]}")
    elif isinstance(payload, list):
        out.append(f"{prefix}[] 길이 {len(payload)}")
        if payload:
            _walk_keys(payload[0], f"{prefix}[0]", depth + 1, out)
    return out


def probe_one(label: str, url: str, params: dict[str, Any] | None) -> None:
    print(f"\n{'─' * 78}\n▶ {label}\n  {url}", flush=True)
    try:
        if params:
            # KRX는 POST + Referer 정합을 요구한다(trstk.py에서 배운 것).
            headers = {**HEADERS, "Referer": "https://data.krx.co.kr/"}
            resp = requests.post(url, data=params, headers=headers, timeout=TIMEOUT)
        else:
            resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ 요청 실패: {type(exc).__name__}: {exc}", flush=True)
        return

    print(f"  status={resp.status_code} · {len(resp.text):,}자", flush=True)
    # 400과 404는 전혀 다르다 — 400이면 주소는 맞고 조건만 모르는 상태다(trstk.py 교훈).
    if resp.status_code == 400:
        print("  ⓘ 400 = 주소는 맞고 파라미터만 틀렸을 가능성이 크다. 본문을 볼 것.", flush=True)

    try:
        payload = resp.json()
    except ValueError:
        print(f"  ✗ JSON 아님(봇 차단 페이지는 200+HTML로 온다): {body_snippet(resp)}", flush=True)
        return

    print("  ✓ JSON 수신 — 키 구조:", flush=True)
    for line in _walk_keys(payload):
        print(f"      {line}", flush=True)

    # 비중으로 쓸 만한 숫자가 실제로 들어 있는지 눈으로 확인할 수 있게 원문 일부도 남긴다.
    raw = json.dumps(payload, ensure_ascii=False)
    print(f"  원문 앞부분: {raw[:400]}{'...' if len(raw) > 400 else ''}", flush=True)


def main() -> None:
    print(f"490590 구성종목·비중 소스 탐색 ({len(_CANDIDATES)}개 후보)")
    print("성패를 판정하지 않는다 — 어떤 키로 오는지 보고 수집기를 짜는 것이 목적이다.")
    for label, url, params in _CANDIDATES:
        probe_one(label, url, params)
    print(
        f"\n{'─' * 78}\n"
        "다음 단계: 비중 숫자가 실제로 찍힌 경로가 있으면 그 키 이름을 고정하지 말고\n"
        "  후보 목록으로 찾는 수집기를 짠다(naver_api.rows_from_json / find_first 참고).\n"
        "  하나도 없으면 비중 가중은 보류하고, 5개 동등 가중을 유지한다 — 추측한 비중을\n"
        "  넣는 것이 지금보다 나을 이유가 없다.",
    )


if __name__ == "__main__":
    main()
