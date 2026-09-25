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

from .naver_api import HEADERS, TIMEOUT, body_snippet, find_first

ETF_CODE = "490590"

# 위에서부터 두드린다. 어느 것이 살아 있는지 모르므로 **판정하지 않고 구조만 찍는다.**
# 2026-09-16 1차 탐색 결과 — 판정이 아니라 **실측**이다:
#   ✓ m.stock.naver.com/api/stock/{code}/etfAnalysis  → 200, etfTop10MajorConstituentAssets 있음
#   ✗ api.stock.naver.com/etf/{code}/constituents     → 404
#   ✗ api.stock.naver.com/etf/{code}                  → 400 MethodArgumentTypeMismatch
#   ✗ api.stock.naver.com/stock/{code}/integration    → 409 StockConflict (ETF는 이 경로가 아님)
#   ✗ data.krx.co.kr .../getJsonData.cmd              → 400 "LOGOUT" (세션 쿠키 필요, trstk.py 참고)
# 살아 있는 경로만 남기고, 정작 필요한 구성종목 리스트를 **통째로** 찍는다.
_CANDIDATES: list[tuple[str, str, dict[str, Any] | None]] = [
    ("네이버 모바일 ETF 분석", f"https://m.stock.naver.com/api/stock/{ETF_CODE}/etfAnalysis", None),
]

# 이 키 안에 구성종목·비중이 들어 있다. 키 이름이 바뀔 수 있으므로 후보로 찾는다.
_HOLDING_KEYS = (
    "etfTop10MajorConstituentAssets",
    "majorConstituentAssets",
    "constituentAssets",
    "holdings",
)


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


def probe_one(label: str, url: str, params: dict[str, Any] | None) -> list[dict] | None:
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
        return None

    print(f"  status={resp.status_code} · {len(resp.text):,}자", flush=True)
    # 400과 404는 전혀 다르다 — 400이면 주소는 맞고 조건만 모르는 상태다(trstk.py 교훈).
    if resp.status_code == 400:
        print("  ⓘ 400 = 주소는 맞고 파라미터만 틀렸을 가능성이 크다. 본문을 볼 것.", flush=True)

    try:
        payload = resp.json()
    except ValueError:
        print(f"  ✗ JSON 아님(봇 차단 페이지는 200+HTML로 온다): {body_snippet(resp)}", flush=True)
        return None

    print("  ✓ JSON 수신 — 키 구조:", flush=True)
    for line in _walk_keys(payload):
        print(f"      {line}", flush=True)

    # ── 정작 필요한 것: 구성종목·비중 리스트를 통째로 ──────────────────────
    # 위 _walk_keys는 깊이·길이를 잘라서 리스트 내용을 안 편다(1차 실행에서 실제로
    # etfTop10MajorConstituentAssets가 "(list)"로만 찍히고 내용이 안 보였다).
    holdings = find_first(payload, _HOLDING_KEYS)
    if isinstance(holdings, list) and holdings:
        print(f"\n  ★ 구성종목 {len(holdings)}개 — 전체:", flush=True)
        for item in holdings:
            print(f"      {json.dumps(item, ensure_ascii=False)}", flush=True)
    else:
        print(f"\n  ✗ 구성종목 리스트를 못 찾음 (후보 키: {', '.join(_HOLDING_KEYS)})", flush=True)

    raw = json.dumps(payload, ensure_ascii=False)
    print(f"\n  원문 앞부분: {raw[:300]}{'...' if len(raw) > 300 else ''}", flush=True)
    return holdings if isinstance(holdings, list) else None



# ── 2단계: 이름 → 티커 + 비중 계산이 실제로 되는지 검산 ────────────────────
# 네이버는 미국 종목의 itemCode를 **빈 문자열로** 준다(실측). 이름("NVIDIA CORP")밖에
# 없으므로 stock_universe의 name과 이어야 하는데, 그게 실제로 붙는지 **먼저 확인**한다.
# 붙지 않는 이름이 하나라도 있으면 그 종목이 조용히 빠져 신호등이 틀린 바구니로
# 계산된다 — 지금 벌어지고 있는 일이 정확히 그것이다.

# 네이버 표기와 stock_universe 표기가 다를 수 있어 손으로 못 박아 두는 별칭.
# **비워두고 시작한다** — 프로브가 못 붙인 이름을 찍어 주면 그때 근거를 갖고 추가한다.
_NAME_ALIASES: dict[str, str] = {}

# 국내 상장 ETF는 이름 그대로 itemCode가 오고(485690), 미국 개별주와 성격이 달라
# 여기서 갈라낸다 — 490590이 담은 RISE TOP3Plus는 NVDA·GOOGL·MRVL을 다시 담고 있어
# 그대로 세면 같은 종목을 두 번 세게 된다(CLAUDE.md에 적힌 이유).
def _is_domestic_etf(item: dict) -> bool:
    return bool(str(item.get("itemCode") or "").strip())


def _normalize(name: str) -> str:
    """'NVIDIA CORP' ↔ 'NVIDIA Corp' 같은 표기 차이를 흡수한다."""
    out = name.upper()
    for suffix in (" INC-CL A", " INC-A", " CO-A", " CORP", " INC", " CO", " LTD", " PLC", "."):
        out = out.replace(suffix, " ")
    return " ".join(out.split())


def resolve_and_weight(holdings: list[dict]) -> None:
    from .db import ScreenerDB

    print(f"\n{'─' * 78}\n▶ 이름 → 티커 잇기 + 비중 계산 검산", flush=True)
    db = ScreenerDB.from_env()

    rows = []
    start = 0
    while True:
        res = (
            db.client.table("stock_universe")
            .select("ticker, name")
            .eq("market", "US")
            .range(start, start + 999)
            .execute()
        )
        batch = res.data or []
        rows.extend(batch)
        if len(batch) < 1000:
            break
        start += 1000
    print(f"  stock_universe US {len(rows)}개 로드", flush=True)

    by_name: dict[str, str] = {}
    for row in rows:
        if row.get("name"):
            by_name.setdefault(_normalize(row["name"]), row["ticker"])

    resolved: list[tuple[str, str, int]] = []
    unresolved: list[str] = []
    for item in holdings:
        name = item.get("itemName", "")
        if _is_domestic_etf(item):
            print(f"  · 국내 ETF라 제외: {name} ({item.get('itemCode')})", flush=True)
            continue
        count = int(str(item.get("stockCount", "0")).replace(",", "") or 0)
        ticker = _NAME_ALIASES.get(name) or by_name.get(_normalize(name))
        if ticker:
            resolved.append((name, ticker, count))
        else:
            unresolved.append(name)

    print(f"\n  이어짐 {len(resolved)}개 / 못 이음 {len(unresolved)}개", flush=True)
    for name in unresolved:
        print(f"    ✗ {name}  → _NAME_ALIASES에 추가해야 한다", flush=True)

    if not resolved:
        print("  비중 계산 불가 — 이은 종목이 없다", flush=True)
        return

    # 비중 = 주식 수 × 주가. 절대 비중은 1좌(CU)당 수량이라 알 수 없지만, 신호등이
    # 쓰는 건 **판정 대상끼리의 상대 비중**(cStageWeight / evaluatedWeight)이라
    # 상대값만 맞으면 된다.
    import yfinance as yf

    tickers = [t for _, t, _ in resolved]
    data = yf.download(tickers, period="5d", progress=False)["Close"]
    values: list[tuple[str, str, int, float, float]] = []
    for name, ticker, count in resolved:
        try:
            price = float(data[ticker].dropna().iloc[-1])
        except Exception:  # noqa: BLE001
            print(f"    ✗ {ticker} 종가 없음 — 비중에서 뺀다", flush=True)
            continue
        values.append((name, ticker, count, price, count * price))

    total = sum(v[-1] for v in values)
    print(f"\n  {'종목':<28} {'티커':<7} {'주식수':>8} {'종가':>10} {'상대비중':>9}", flush=True)
    for name, ticker, count, price, value in sorted(values, key=lambda v: -v[-1]):
        print(
            f"  {name[:27]:<28} {ticker:<7} {count:>8,} {price:>10,.2f} {value / total * 100:>8.2f}%",
            flush=True,
        )

    # 손으로 적어둔 2026-09-16 스냅샷과 **순서**를 비교한다. 비중 절대값은 분모가
    # 달라(그땐 ETF 전체, 여긴 상위10) 그대로 못 맞추지만, 순서가 뒤집히면 계산이
    # 틀렸다는 신호다.
    old = {"NVDA": 14.67, "GOOGL": 13.97, "MRVL": 10.46, "PLTR": 5.80,
           "MSFT": 5.70, "META": 5.06, "ANET": 5.01, "AMZN": 4.65}
    print("\n  손으로 적어둔 2026-09-16 값과 대조(그때도 있던 종목만):", flush=True)
    for name, ticker, count, price, value in sorted(values, key=lambda v: -v[-1]):
        if ticker in old:
            print(f"    {ticker:<7} 계산 {value / total * 100:>6.2f}%  ↔  당시 {old[ticker]:>5.2f}%", flush=True)


def main() -> None:
    print(f"490590 구성종목·비중 소스 탐색 ({len(_CANDIDATES)}개 후보)")
    print("성패를 판정하지 않는다 — 어떤 키로 오는지 보고 수집기를 짜는 것이 목적이다.")
    found: list[dict] | None = None
    for label, url, params in _CANDIDATES:
        result = probe_one(label, url, params)
        if result:
            found = result
    if found:
        try:
            resolve_and_weight(found)
        except Exception as exc:  # noqa: BLE001
            print(f"\n  ✗ 검산 실패: {type(exc).__name__}: {exc}", flush=True)
    print(
        f"\n{'─' * 78}\n"
        "다음 단계: 비중 숫자가 실제로 찍힌 경로가 있으면 그 키 이름을 고정하지 말고\n"
        "  후보 목록으로 찾는 수집기를 짠다(naver_api.rows_from_json / find_first 참고).\n"
        "  하나도 없으면 비중 가중은 보류하고, 5개 동등 가중을 유지한다 — 추측한 비중을\n"
        "  넣는 것이 지금보다 나을 이유가 없다.",
    )


if __name__ == "__main__":
    main()
