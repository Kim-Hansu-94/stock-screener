"""490590 구성종목·비중 수집 → `etf_holdings`.

왜 필요한가 (2026-09-25)
------------------------
`frontend/lib/etfEntryCheck.ts`가 구성종목 8개를 **코드에 손으로 적어** 두고 있었다.
지수가 리밸런싱되면 아무도 모르고, 화면은 조용히 틀린 바구니로 신호등을 계산한다 —
실제로 그렇게 됐다. 2026-09-16에 적어둔 목록과 2026-09-25 실측을 맞대어 보니
**10개 중 5개가 어긋나 있었다**(인텔·오라클·버티브가 들어오고 마이크로소프트·메타가
빠졌는데, 화면은 여전히 빠진 둘을 세고 들어온 셋을 무시하고 있었다).

무엇이 오고 무엇이 안 오는가 (프로브 실측, 추측 아님)
--------------------------------------------------
소스는 `m.stock.naver.com/api/stock/{code}/etfAnalysis`의
`etfTop10MajorConstituentAssets`다. 실제로 오는 모양:

    {"seq": 2, "itemCode": "", "itemName": "NVIDIA CORP",
     "stockCount": "312", "etfWeight": "-"}

  · **비중(`etfWeight`)은 안 준다** — 10개 전부 `"-"`다.
  · **티커(`itemCode`)도 미국 종목은 빈 문자열**이다. 이름밖에 없다.
  · 국내 상장 ETF만 `itemCode`가 채워져 온다(485690 RISE TOP3Plus).
  · **상위 10개까지만** 준다 — ETF 전체 구성이 아니다.

그래서 두 가지를 우리가 해야 한다.

1. **이름 → 티커**: `stock_universe`의 US 종목명과 잇는다. 표기가 달라서
   (`"AMAZON.COM INC"` ↔ DB `"Amazon"`) 정규화가 필요하고, 그마저도 안 붙는 건
   `_NAME_ALIASES`로 못 박는다. **못 이은 이름은 절대 조용히 버리지 않는다** —
   그게 지금 벌어진 사고의 방식이기 때문에, 행은 남기고(ticker=null) 로그에
   `::warning::`으로 띄운다.

2. **비중**: `주식 수 × 주가`. 이건 추정이 아니라 비중의 정의 그대로다. 다만
   **상위 10개 안에서의 상대 비중**만 알 수 있다(전체 구성을 안 주므로 ETF 전체에서
   몇 %인지는 모른다). 화면이 쓰는 것도 `cStageWeight / evaluatedWeight`라는
   **판정 대상끼리의 상대 비중**이라 이걸로 충분하다.

   주가는 yfinance가 아니라 **`stock_price_history`에서 읽는다** — 이미 매일 저장하는
   값이고, 프로브 4차 실행에서 yfinance가 `OperationalError('database is locked')`로
   ANET 하나를 흘려 비중이 통째로 틀어진 적이 있다(외부 호출이 하나 줄면 실패 지점도
   하나 준다).

소스가 살아 있는지는 `.github/workflows/etf_holdings_probe.yml`로 1분 만에 확인된다.
"""

from __future__ import annotations

from datetime import date, timedelta

from .naver_api import find_first, get_json

ETF_CODE = "490590"

# 화면이 실제로 쓰는 구성종목 (frontend/lib/etfEntryCheck.ts의 FALLBACK_PROXY_HOLDINGS).
# **둘은 손으로 맞춰야 하는 동기화 지점이다** — TS를 파싱해서 읽을 수도 있지만, 그러면
# 파이프라인이 프론트 소스 구조에 묶여 리팩터링 한 번에 조용히 깨진다. 여기선 티커만
# 알면 되고(비중은 화면 쪽만 쓴다) 목록이 바뀌는 일 자체가 드물어서 상수로 둔다.
# 어긋나면 etf_holdings_main이 "바뀌었다"고 잘못 알릴 뿐이라 안전한 쪽으로 실패한다.
#
# 수집기가 아니라 여기(라이브러리)에 두는 이유: main.py도 이 목록을 읽는다.
# 정규 유니버스(S&P500·NASDAQ100) 밖 종목의 일봉을 같이 받으려면 "화면이 어떤
# 종목을 쓰는지"를 알아야 하고, 그걸 세 번째 상수로 또 적으면 어긋날 곳이 하나 더 는다.
KNOWN_TICKERS = frozenset({
    "MRVL", "NVDA", "GOOGL", "INTC", "AMD", "MU", "META", "TSM",
    "VRT", "AVGO", "PLTR", "ANET", "ORCL", "AMZN", "MSFT",
})
_URL = f"https://m.stock.naver.com/api/stock/{ETF_CODE}/etfAnalysis"

# 감싸는 키 이름은 예고 없이 바뀌므로 고정하지 않고 후보로 찾는다(naver_api 원칙).
_HOLDING_KEYS = (
    "etfTop10MajorConstituentAssets",
    "majorConstituentAssets",
    "constituentAssets",
    "holdings",
)
_AS_OF_KEYS = ("navPerformanceReferenceDate", "returnPerformanceReferenceDate", "referenceDate")

# 법인격·주식 종류 단어. **글자가 아니라 단어 단위로** 떼어낸다 — 글자로 자르면
# "ORACLE CORPORATION"에서 " CORP"를 빼 "ORACLE ORATION"이 된다(실제로 겪었다).
_CORPORATE_TOKENS = frozenset({
    "INC", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "LIMITED", "PLC",
    "SA", "NV", "AG", "CLASS", "CL", "A", "B", "C", "GROUP", "HOLDINGS",
})

# 정규화로도 안 붙는 이름을 못 박는 곳. **프로브가 찍어 준 DB 실제 표기를 보고
# 채운다** — 추측으로 넣으면 틀렸을 때 그 종목이 조용히 빠진다.
_NAME_ALIASES: dict[str, str] = {}

# 미국 일봉이 며칠 비어도(연휴·수집 실패) 최근 종가를 찾도록 여유를 둔다.
_PRICE_LOOKBACK_DAYS = 14


def normalize_name(name: str) -> str:
    """'AMAZON.COM INC' ↔ 'Amazon' 같은 표기 차이를 흡수한다."""
    cleaned = "".join(ch if ch.isalnum() else " " for ch in name.upper())
    return " ".join(t for t in cleaned.split() if t not in _CORPORATE_TOKENS)


def resolve_ticker(name: str, by_name: dict[str, str]) -> str | None:
    """구성종목 이름을 티커로 잇는다. 정확히 같은 이름 → 접두사 → 별칭 순.

    접두사까지 보는 이유는 네이버가 긴 정식명("VERTIV HOLDINGS CO-A")을,
    stock_universe가 짧은 통칭("Vertiv")을 쓰기 때문이다(프로브 실측).
    **후보가 둘 이상이면 잇지 않는다** — 엉뚱한 종목을 골라 조용히 틀린 비중을
    만드는 것보다, 못 이었다고 드러내는 편이 낫다.
    """
    if name in _NAME_ALIASES:
        return _NAME_ALIASES[name]

    target = normalize_name(name)
    if not target:
        return None
    if target in by_name:
        return by_name[target]

    matches = {
        ticker for db_name, ticker in by_name.items()
        if db_name and (target.startswith(db_name + " ") or target == db_name)
    }
    return matches.pop() if len(matches) == 1 else None


def _latest_closes(db, tickers: list[str], today: date) -> dict[str, float]:
    """stock_price_history에서 종목별 최신 종가를 읽는다.

    yfinance를 쓰지 않는 이유는 모듈 docstring 참고(외부 호출 하나가 흔들리면
    비중 전체가 틀어진다).
    """
    if not tickers:
        return {}
    cutoff = (today - timedelta(days=_PRICE_LOOKBACK_DAYS)).isoformat()
    result = (
        db.client.table("stock_price_history")
        .select("ticker, date, close")
        .eq("market", "US")
        .in_("ticker", tickers)
        .gte("date", cutoff)
        .order("date", desc=False)
        .execute()
    )
    closes: dict[str, float] = {}
    for row in result.data or []:
        # 날짜 오름차순이라 뒤에 오는 행이 더 최신이다.
        closes[row["ticker"]] = float(row["close"])
    return closes


def _universe_by_name(db) -> dict[str, str]:
    rows: list[dict] = []
    start = 0
    while True:
        result = (
            db.client.table("stock_universe")
            .select("ticker, name")
            .eq("market", "US")
            .range(start, start + 999)
            .execute()
        )
        batch = result.data or []
        rows.extend(batch)
        if len(batch) < 1000:
            break
        start += 1000

    by_name: dict[str, str] = {}
    for row in rows:
        if row.get("name"):
            by_name.setdefault(normalize_name(row["name"]), row["ticker"])
    return by_name


def collect_etf_holdings(db, today: date | None = None) -> list[dict]:
    """네이버에서 상위 구성종목을 받아 `etf_holdings` 행으로 만든다.

    국내 상장 ETF(itemCode가 채워져 오는 행)는 제외한다 — 490590이 담은
    RISE TOP3Plus는 NVDA·GOOGL·MRVL을 다시 담고 있어 그대로 세면 같은 종목을
    두 번 세게 된다.
    """
    today = today or date.today()
    payload = get_json(_URL)

    holdings = find_first(payload, _HOLDING_KEYS)
    if not isinstance(holdings, list) or not holdings:
        raise RuntimeError(
            f"구성종목 리스트를 못 찾았다 (후보 키: {', '.join(_HOLDING_KEYS)}). "
            "네이버가 키 이름을 바꿨을 수 있다 — etf_holdings_probe로 구조를 확인할 것."
        )

    as_of = str(find_first(payload, _AS_OF_KEYS) or "").replace(".", "-") or today.isoformat()
    by_name = _universe_by_name(db)

    rows: list[dict] = []
    unresolved: list[str] = []
    for item in holdings:
        name = str(item.get("itemName") or "").strip()
        if not name:
            continue
        # 국내 ETF는 itemCode가 채워져 온다(미국 개별주는 빈 문자열) — 그걸로 갈라낸다.
        if str(item.get("itemCode") or "").strip():
            print(f"  · 국내 ETF라 제외: {name} ({item['itemCode']})", flush=True)
            continue
        try:
            count = int(str(item.get("stockCount") or "0").replace(",", ""))
        except ValueError:
            count = 0
        ticker = resolve_ticker(name, by_name)
        if ticker is None:
            unresolved.append(name)
        rows.append({
            "etf_ticker": ETF_CODE,
            "seq": int(item.get("seq") or len(rows) + 1),
            "ticker": ticker,
            "name": name,
            "stock_count": count,
            "weight_pct": None,
            "as_of": as_of,
            "updated_at": today.isoformat(),
        })

    # ── 비중: 주식 수 × 주가를 이은 종목끼리 100%로 정규화 ──────────────────
    resolved = [r for r in rows if r["ticker"]]
    closes = _latest_closes(db, [r["ticker"] for r in resolved], today)
    priced = [(r, closes[r["ticker"]]) for r in resolved if r["ticker"] in closes]
    total = sum(r["stock_count"] * price for r, price in priced)
    if total > 0:
        for row, price in priced:
            row["weight_pct"] = round(row["stock_count"] * price / total * 100, 4)

    missing_price = [r["ticker"] for r in resolved if r["ticker"] not in closes]
    if missing_price:
        # 일봉이 없으면 비중이 null로 남고 화면은 그 종목을 '판정 불가'로 센다.
        # 조용히 0으로 깔면 "데이터가 없다"와 "비중이 0이다"가 구분되지 않는다.
        print(f"  ::warning::일봉이 없어 비중을 못 낸 종목: {', '.join(missing_price)}", flush=True)
    if unresolved:
        print(
            "  ::warning::이름을 티커로 못 이은 구성종목: "
            f"{', '.join(unresolved)} — etf_holdings._NAME_ALIASES에 추가할 것 "
            "(그때까지 이 종목은 신호등 계산에서 빠진다)",
            flush=True,
        )
    return rows


def describe(rows: list[dict]) -> str:
    lines = [f"  기준일 {rows[0]['as_of'] if rows else '?'} · {len(rows)}종목"]
    for row in sorted(rows, key=lambda r: -(r["weight_pct"] or 0)):
        weight = f"{row['weight_pct']:.2f}%" if row["weight_pct"] is not None else "   -  "
        lines.append(
            f"    {row['name'][:30]:<31} {row['ticker'] or '(못 이음)':<10}"
            f" {row['stock_count']:>7,}주 {weight:>8}"
        )
    return "\n".join(lines)
