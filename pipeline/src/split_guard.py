"""액면분할 등 소급 조정 감지.

이미 수집한 종목은 매 실행마다 최근 며칠치만 받아 덮어쓴다. 그런데 액면분할이
일어나면 데이터 제공자는 과거 가격 전체를 소급해서 다시 계산한다(10:1 분할이면
과거가가 1/10로). 우리는 최근 구간만 덮어쓰므로 DB에는 이렇게 남는다.

    분할 전 저장된 과거:  200,000  (조정 안 된 옛 값)
    분할 후 받은 최근:     20,000  (조정된 값)

실제로는 아무 일도 없었는데 DB 안에서만 -90% 폭락이 만들어진다. 에러가 나지 않아
조용히 통과하며, 조정폭·SMA·박스폭·손익비가 전부 오염되고 해당 종목은 화면에서
사라지거나 이상한 값으로 표시된다.

감지 방법: 증분 수집분은 이미 저장된 날짜와 겹친다. 같은 날짜의 종가가 저장분과
달라졌다면 소급 조정이 일어난 것이므로, 그 종목만 전체 기간을 다시 받는다.
분할뿐 아니라 데이터 정정·배당 조정도 같은 방식으로 잡힌다.
"""

from __future__ import annotations

from .db import ScreenerDB

# 같은 날짜 종가가 이 비율 이상 다르면 소급 조정으로 본다. 정상적인 소수점 반올림
# 차이(수 bp)는 무시하고, 가장 작은 분할(보통 2:1 = 50% 변화)은 확실히 잡는 값.
ADJUST_TOLERANCE = 0.02


def detect_adjusted(db: ScreenerDB, market: str, rows: list[dict]) -> list[str]:
    """증분 수집분과 저장분의 같은 날짜 종가를 비교해 조정된 티커를 찾는다.

    조회에 실패하면 빈 목록을 돌려준다 — 감지는 보호 장치일 뿐이고, 실패했다고
    수집 자체를 막을 이유는 없다.
    """
    if not rows:
        return []

    # 티커별로 비교 기준 1건씩만 뽑는다(가장 오래된 날짜 = 저장분과 겹칠 가능성이 큼)
    probe: dict[str, dict] = {}
    for row in rows:
        current = probe.get(row["ticker"])
        if current is None or row["date"] < current["date"]:
            probe[row["ticker"]] = row
    if not probe:
        return []

    tickers = list(probe)
    dates = sorted({r["date"] for r in probe.values()})
    stored: dict[tuple[str, str], float] = {}
    try:
        page = 1000
        start = 0
        while True:
            result = (
                db.client.table("stock_price_history")
                .select("ticker, date, close")
                .eq("market", market)
                .in_("ticker", tickers)
                .gte("date", dates[0])
                .lte("date", dates[-1])
                .range(start, start + page - 1)
                .execute()
            )
            data = result.data or []
            for r in data:
                stored[(r["ticker"], str(r["date"])[:10])] = float(r["close"])
            if len(data) < page:
                break
            start += page
    except Exception as exc:  # noqa: BLE001
        print(f"  조정 감지 조회 실패 (건너뜀): {exc}", flush=True)
        return []

    adjusted: list[str] = []
    for ticker, row in probe.items():
        old = stored.get((ticker, row["date"]))
        if old is None or old <= 0:
            continue
        if abs(row["close"] - old) / old >= ADJUST_TOLERANCE:
            adjusted.append(ticker)
    return adjusted


def report(market: str, adjusted: list[str]) -> None:
    if adjusted:
        preview = ", ".join(adjusted[:10])
        more = f" 외 {len(adjusted) - 10}개" if len(adjusted) > 10 else ""
        print(f"  {market} 소급 조정 감지 {len(adjusted)}개 → 전체 재수집: {preview}{more}", flush=True)
