"""거래량 신호가 이상할 때 쓰는 진단 — `python -m src.volume_probe [종목코드]`.

포지션 관리 카드의 '거래량 실린 상승'이 SK하이닉스에서 계속 0.9배로 나온다는
신고(2026-09-23)에서 나왔다. 계산식(최근 5일 평균 ÷ 그 이전 20일 평균)만 봐서는
맞고 틀림을 알 수 없다 — **들어가는 값이 맞는지**를 봐야 하는데, 작업용 컨테이너에는
Supabase 자격증명도 네이버 접속도 없다.

그래서 세 가지를 나란히 찍는다.
  (1) DB(stock_price_history)에 저장된 일봉
  (2) 지금 거래소에서 받은 일봉 (FinanceDataReader = 네이버 fchart)
  (3) 화면이 하는 계산(supportSignals.ts volumeRiseSignal)을 그대로 재현한 값

**어느 쪽이 틀렸는지를 가리는 것이 목적이다** — 저장이 잘못된 것과, 저장은 맞는데
계산이 잘못된 것과, 둘 다 맞아서 정말 0.9배인 것은 대응이 전혀 다르다.
"""
from __future__ import annotations

import sys
from datetime import date, timedelta

from dotenv import load_dotenv

from .db import ScreenerDB

# supportSignals.ts와 같은 값이어야 재현이 성립한다.
_RECENT_WINDOW = 5
_BASE_WINDOW = 20

_DEFAULT_TICKER = "000660"  # SK하이닉스
_SHOW_BARS = 30


def _db_bars(db: ScreenerDB, ticker: str, market: str, limit: int) -> list[dict]:
    result = (
        db.client.table("stock_price_history")
        .select("date, open, high, low, close, volume")
        .eq("ticker", ticker)
        .eq("market", market)
        .order("date", desc=True)
        .limit(limit)
        .execute()
    )
    return list(reversed(result.data or []))


def _live_bars(ticker: str, days: int) -> list[dict]:
    import FinanceDataReader as fdr

    end = date.today()
    start = end - timedelta(days=days)
    df = fdr.DataReader(ticker, start.isoformat(), end.isoformat())
    return [
        {
            "date": idx.date().isoformat(),
            "close": float(row["Close"]),
            "volume": float(row["Volume"]),
        }
        for idx, row in df.iterrows()
    ]


def _ratio(volumes: list[float]) -> tuple[float | None, float, float]:
    """화면과 똑같이 최근 5일 평균 ÷ 직전 20일 평균."""
    needed = _RECENT_WINDOW + _BASE_WINDOW
    if len(volumes) < needed:
        return None, 0.0, 0.0
    recent = volumes[-_RECENT_WINDOW:]
    base = volumes[-needed:-_RECENT_WINDOW]
    recent_avg = sum(recent) / len(recent)
    base_avg = sum(base) / len(base)
    if base_avg <= 0:
        return None, recent_avg, base_avg
    return recent_avg / base_avg, recent_avg, base_avg


def _ratio_history(bars: list[dict]) -> None:
    """과거 모든 날에 대해 같은 계산을 돌려 **이 지표가 보통 어디에 머무는지** 본다.

    오늘 0.94가 나왔다는 것만으로는 "거래량이 실제로 줄었다"인지 "이 지표는 원래
    1을 잘 안 넘는다"인지 구분할 수 없다. 거래량 분포는 오른쪽으로 길게 꼬리를
    끄는 형태(가끔 터지는 날)라, 5일 평균이 20일 평균보다 **대부분의 날 낮게**
    나올 수 있다 — 그렇다면 '거래량 실린 상승'은 조건이 아니라 사실상 상수가 된다.
    저점 매집 후보 채점에서 거래량이 표본 대부분에게 만점을 줘 상수였던 것과
    같은 종류의 문제다(pattern_discovery.py v8).
    """
    needed = _RECENT_WINDOW + _BASE_WINDOW
    volumes = [float(b["volume"]) for b in bars]
    ratios: list[tuple[str, float]] = []
    for end in range(needed, len(volumes) + 1):
        ratio, _, _ = _ratio(volumes[:end])
        if ratio is not None:
            ratios.append((bars[end - 1]["date"], ratio))

    if not ratios:
        print("\n  (이력이 모자라 분포를 못 낸다)", flush=True)
        return

    values = sorted(r for _, r in ratios)
    n = len(values)
    below = sum(1 for v in values if v <= 1.0)
    median = values[n // 2]
    print(f"\n--- 이 지표가 보통 어디에 머무는가 ({n}일) ---", flush=True)
    print(f"  1배 이하인 날: {below}/{n}일 ({below / n * 100:.0f}%)", flush=True)
    print(
        f"  최솟값 {values[0]:.2f} · 중간값 {median:.2f} · 최댓값 {values[-1]:.2f}",
        flush=True,
    )
    print("  최근 20일 추이:", flush=True)
    for day, ratio in ratios[-20:]:
        bar = "#" * max(1, round(ratio * 20))
        print(f"    {day}  {ratio:.2f}배  {bar}", flush=True)


def _report(label: str, bars: list[dict]) -> None:
    print(f"\n--- {label} ({len(bars)}봉) ---", flush=True)
    if not bars:
        print("  봉 없음", flush=True)
        return
    for bar in bars[-_SHOW_BARS:]:
        print(
            f"  {bar['date']}  종가 {bar['close']:>12,.0f}  거래량 {bar['volume']:>14,.0f}",
            flush=True,
        )
    ratio, recent_avg, base_avg = _ratio([float(b["volume"]) for b in bars])
    print(
        f"  → 최근 {_RECENT_WINDOW}일 평균 {recent_avg:,.0f} / "
        f"직전 {_BASE_WINDOW}일 평균 {base_avg:,.0f} = "
        + (f"{ratio:.2f}배 (화면 표기 {ratio:.1f}배)" if ratio is not None else "판정 불가"),
        flush=True,
    )


def main() -> None:
    ticker = sys.argv[1] if len(sys.argv) > 1 else _DEFAULT_TICKER
    market = sys.argv[2] if len(sys.argv) > 2 else "KR"
    print(f"대상: {market} {ticker}", flush=True)

    load_dotenv()
    db = ScreenerDB.from_env()

    # 화면은 180일치를 받아 그 안에서 계산한다 — 같은 양을 본다.
    db_bars = _db_bars(db, ticker, market, 180)
    _report("DB(stock_price_history)에 저장된 값", db_bars)
    _ratio_history(db_bars)

    if market == "KR":
        try:
            live = _live_bars(ticker, 60)
        except Exception as exc:  # noqa: BLE001
            print(f"\n거래소 직접 조회 실패: {exc}", flush=True)
            live = []
        _report("지금 거래소에서 받은 값 (FinanceDataReader)", live)

        # 날짜별로 맞대어 **어느 날 어긋나는지**를 짚는다. 평균만 비교하면
        # "조금 다르다"까지만 알 수 있고 원인을 못 찾는다.
        if live:
            db_by_date = {b["date"]: float(b["volume"]) for b in db_bars}
            print("\n--- 날짜별 대조 (최근 30일) ---", flush=True)
            mismatches = 0
            for bar in live[-_SHOW_BARS:]:
                saved = db_by_date.get(bar["date"])
                if saved is None:
                    print(f"  {bar['date']}  DB에 없음 · 거래소 {bar['volume']:,.0f}", flush=True)
                    mismatches += 1
                elif abs(saved - bar["volume"]) > 1:
                    print(
                        f"  {bar['date']}  DB {saved:,.0f} ≠ 거래소 {bar['volume']:,.0f}"
                        f"  (차이 {saved - bar['volume']:+,.0f})",
                        flush=True,
                    )
                    mismatches += 1
            print(f"  어긋난 날: {mismatches}일", flush=True)


if __name__ == "__main__":
    main()
