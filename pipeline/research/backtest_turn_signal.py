"""
"상승 전환 감지"(박스 상단 돌파) 백테스트
================================
사용자 질문: 지금까지 "저점 대비 몇 배 오른 뒤에야 알려준다"고 느꼈던 종목들에
새 방식(qualified_since + 박스 상단 돌파, pipeline/src/watchlist.py의
detect_box_breakout)을 적용했다면, 실제로 저점 근처에서 알아차렸을지 확인한다.

방법: 실제 시세 이력을 하루하루 되짚으며, 그날까지의 데이터만 갖고
evaluate_watch()/detect_box_breakout()을 매일 다시 계산한다(미래 데이터를
보지 않는 walk-forward 방식). qualified_since가 처음 뜬 날, 그리고 그 뒤
"상승 전환" 신호가 처음 뜬 날을 찾아 그때 가격을 실제 저점·오늘 가격과 비교한다.

비교를 위해 이평 정배열(aligned_mas) 기준도 같이 계산한다(watchlist_status/
감시 종목 카드가 쓰는 신호).

실행법 (프로젝트 루트에서, 네트워크 접근 가능한 환경 — GitHub Actions 등):
    python -m pipeline.research.backtest_turn_signal
"""

from __future__ import annotations

from dataclasses import dataclass, field

import FinanceDataReader as fdr

from pipeline.src.watchlist import MIN_BARS, detect_box_breakout, evaluate_watch

TICKERS = [
    ("005945", "NH투자증권우"),
    ("024110", "기업은행"),
]
START_DATE = "2021-01-01"


@dataclass
class Timeline:
    qualified_since: str | None = None
    breakout_since: str | None = None
    aligned_since: str | None = None
    # (날짜, 종가) — 각 신호가 "이번 연속 구간"에서 처음 뜬 시점의 실제 시세
    first_qualified: tuple[str, float] | None = None
    first_breakout_after_qualified: tuple[str, float] | None = None
    first_aligned_after_qualified: tuple[str, float] | None = None
    events: list[str] = field(default_factory=list)


def load_bars(ticker: str) -> list[dict]:
    df = fdr.DataReader(ticker, START_DATE)
    df = df.reset_index()
    bars = []
    for _, row in df.iterrows():
        bars.append({
            "date": row["Date"].strftime("%Y-%m-%d"),
            "open": float(row["Open"]),
            "high": float(row["High"]),
            "low": float(row["Low"]),
            "close": float(row["Close"]),
            "volume": float(row["Volume"]),
        })
    return bars


def walk_forward(bars: list[dict]) -> Timeline:
    tl = Timeline()
    prev_qualified = False
    prev_aligned = False
    for i in range(MIN_BARS, len(bars) + 1):
        window = bars[:i]
        today = window[-1]
        status = evaluate_watch(window)
        qualified = bool(status["qualified"])

        if qualified and not prev_qualified:
            tl.qualified_since = today["date"]
            tl.first_qualified = (today["date"], today["close"])
            tl.events.append(f"{today['date']}: qualified_since 시작 (종가 {today['close']:.0f})")
        if not qualified:
            tl.qualified_since = None
            # 매집 구간이 끊기면 그 안에서의 전환 신호 기록도 리셋 —
            # 다음 구간에서 다시 "처음 뜬 시점"을 찾기 위함
            tl.first_breakout_after_qualified = None
            tl.first_aligned_after_qualified = None

        if qualified:
            breakout = detect_box_breakout(window)
            if breakout and tl.first_breakout_after_qualified is None:
                tl.first_breakout_after_qualified = (today["date"], today["close"])
                tl.events.append(f"{today['date']}: 박스 상단 돌파 최초 감지 (종가 {today['close']:.0f})")

            aligned = bool(status.get("aligned_mas"))
            if aligned and not prev_aligned and tl.first_aligned_after_qualified is None:
                tl.first_aligned_after_qualified = (today["date"], today["close"])
                tl.events.append(f"{today['date']}: 이평 정배열 최초 감지 (종가 {today['close']:.0f})")
            prev_aligned = aligned
        else:
            prev_aligned = False

        prev_qualified = qualified

    return tl


def main() -> None:
    for ticker, name in TICKERS:
        print(f"\n{'=' * 60}\n{name} ({ticker})\n{'=' * 60}")
        bars = load_bars(ticker)
        if len(bars) < MIN_BARS:
            print(f"  데이터 부족 ({len(bars)}봉)")
            continue

        low_bar = min(bars, key=lambda b: b["low"])
        today_bar = bars[-1]
        print(f"  전체 조회 기간: {bars[0]['date']} ~ {bars[-1]['date']} ({len(bars)}봉)")
        print(f"  실제 최저가: {low_bar['date']} @ {low_bar['low']:.0f}")
        print(f"  오늘(조회 시점) 종가: {today_bar['date']} @ {today_bar['close']:.0f} "
              f"(저점 대비 {(today_bar['close'] - low_bar['low']) / low_bar['low'] * 100:+.0f}%)")

        tl = walk_forward(bars)

        print("\n  -- 이번 turn-signal 개편 이전(qualified_since조차 없던 기준) --")
        if tl.first_qualified:
            d, price = tl.first_qualified
            pct_from_low = (price - low_bar["low"]) / low_bar["low"] * 100
            print(f"  최초 qualified_since(후보 등록): {d} @ {price:.0f} (저점 대비 +{pct_from_low:.0f}%)")
        else:
            print("  기간 내 한 번도 하드필터 통과 못함")

        print("\n  -- 상승 전환 신호 비교 (qualified 상태에서 처음 뜬 시점) --")
        for label, event in [
            ("박스 상단 돌파(신규 채택)", tl.first_breakout_after_qualified),
            ("이평 정배열(감시 종목이 쓰는 방식)", tl.first_aligned_after_qualified),
        ]:
            if event:
                d, price = event
                pct_from_low = (price - low_bar["low"]) / low_bar["low"] * 100
                pct_to_today = (today_bar["close"] - price) / price * 100
                print(f"  {label}: {d} @ {price:.0f}"
                      f" (저점 대비 +{pct_from_low:.0f}%, 이후 오늘까지 추가 +{pct_to_today:.0f}%)")
            else:
                print(f"  {label}: 기간 내 미발생")

        print("\n  -- 상세 이벤트 로그 --")
        for e in tl.events:
            print(f"  {e}")


if __name__ == "__main__":
    main()
