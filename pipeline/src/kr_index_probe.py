"""네이버에서 코스피/코스닥 일봉을 받을 수 있는지 두드려 보는 진단 스크립트.

작업용 컨테이너는 네이버로 나가는 길이 막혀 있어(프록시 403) 여기서 확인할 수 없다.
`.github/workflows/kr_index_probe.yml`로 GitHub Actions에서 돌려 결과를 본다.
(universe_probe.yml과 같은 이유·같은 방식)

왜 필요한가: 2026-09-10 아침 06:30 실행에서 yfinance(^KS11)가 **에러 없이** 9/8까지만
줬다(해외 지수는 9/9까지 정상). 야후의 KRX 일봉 확정이 하루 늦는 것으로 보여, 국내
지수는 국내 소스에서 받아야 한다.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import requests

KST = timezone(timedelta(hours=9))
_UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://m.stock.naver.com/"}


def _get(url: str) -> requests.Response:
    return requests.get(url, headers=_UA, timeout=20)


def _snippet(text: str, n: int = 300) -> str:
    return text[:n].replace("\n", " ")


def probe_api_stock_price(symbol: str) -> str:
    """네이버 증권 앱 API — 지수 일별 시세."""
    url = f"https://api.stock.naver.com/index/{symbol}/price?pageSize=10&page=1"
    r = _get(url)
    if r.status_code != 200:
        return f"HTTP {r.status_code}: {_snippet(r.text)}"
    try:
        rows = r.json()
    except ValueError:
        return f"JSON 아님: {_snippet(r.text)}"
    if not isinstance(rows, list) or not rows:
        return f"행 없음: {_snippet(json.dumps(rows, ensure_ascii=False))}"
    return f"{len(rows)}행, 첫 행={json.dumps(rows[0], ensure_ascii=False)}"


def probe_sise_json(symbol: str) -> str:
    """네이버 금융 차트용 siseJson — [['날짜','시가',...], [...]] 형태의 유사 JSON."""
    today = datetime.now(KST).date()
    start = (today - timedelta(days=20)).strftime("%Y%m%d")
    end = today.strftime("%Y%m%d")
    url = (
        "https://api.finance.naver.com/siseJson.naver?"
        f"symbol={symbol}&requestType=1&startTime={start}&endTime={end}&timeframe=day"
    )
    r = _get(url)
    if r.status_code != 200:
        return f"HTTP {r.status_code}: {_snippet(r.text)}"
    text = r.text.strip()
    if not text.startswith("["):
        return f"배열 아님: {_snippet(text)}"
    try:
        rows = json.loads(text.replace("'", '"'))
    except ValueError as exc:
        return f"파싱 실패({exc}): {_snippet(text)}"
    return f"{len(rows)}행, 마지막 3행={json.dumps(rows[-3:], ensure_ascii=False)}"


def probe_fchart(symbol: str) -> str:
    """fchart XML — 개별 종목 일봉에 이미 쓰이는 경로(FinanceDataReader 내부)."""
    url = f"https://fchart.stock.naver.com/sise.nhn?symbol={symbol}&timeframe=day&count=10&requestType=0"
    r = _get(url)
    if r.status_code != 200:
        return f"HTTP {r.status_code}: {_snippet(r.text)}"
    return f"본문={_snippet(r.text, 600)}"


def probe_index_basic(symbol: str) -> str:
    """지수 기본 정보 — 최신 종가/기준일만 확인용."""
    url = f"https://api.stock.naver.com/index/{symbol}/basic"
    r = _get(url)
    if r.status_code != 200:
        return f"HTTP {r.status_code}: {_snippet(r.text)}"
    try:
        data = r.json()
    except ValueError:
        return f"JSON 아님: {_snippet(r.text)}"
    return _snippet(json.dumps(data, ensure_ascii=False), 500)


_PROBES = [
    ("api.stock.naver.com /index/KOSPI/price", lambda: probe_api_stock_price("KOSPI")),
    ("api.stock.naver.com /index/KOSDAQ/price", lambda: probe_api_stock_price("KOSDAQ")),
    ("api.stock.naver.com /index/KOSPI/basic", lambda: probe_index_basic("KOSPI")),
    ("siseJson KOSPI", lambda: probe_sise_json("KOSPI")),
    ("siseJson KOSDAQ", lambda: probe_sise_json("KOSDAQ")),
    ("fchart KOSPI", lambda: probe_fchart("KOSPI")),
    ("fchart KOSDAQ", lambda: probe_fchart("KOSDAQ")),
]


def main() -> None:
    now = datetime.now(KST)
    print(f"실행 시각(KST): {now:%Y-%m-%d %H:%M}", flush=True)
    results = []
    for label, fn in _PROBES:
        print(f"\n--- {label} ---", flush=True)
        try:
            out = fn()
        except Exception as exc:  # noqa: BLE001
            out = f"예외: {type(exc).__name__}: {exc}"
        print(out, flush=True)
        results.append((label, out))

    print("\n=== 소스별 결과 ===", flush=True)
    for label, out in results:
        print(f"  {label}: {out[:200]}", flush=True)


if __name__ == "__main__":
    main()
