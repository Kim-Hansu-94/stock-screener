"""보유/관심 종목 감시.

횡보·조정 스크리너와 동일한 기준(frontend/lib/opportunityScore.ts의 하드 필터·
매수 매력도 점수를 그대로 포팅)으로 감시 종목을 매일 평가해 watchlist_status에
저장한다. 결과는 홈 화면 "감시 종목" 카드(WatchlistCard)에 표시된다.

숫자 상수를 바꿀 때는 frontend/lib/opportunityScore.ts와 반드시 함께 바꿀 것.
"""

from __future__ import annotations

from datetime import date, timedelta

from .db import ScreenerDB

# (ticker, market, 표시명). 종목 추가는 여기에 한 줄 추가하면 끝.
WATCHLIST: list[tuple[str, str, str]] = [
    ("000660", "KR", "SK하이닉스"),
]

# ── frontend/lib/opportunityScore.ts 와 동일한 상수 ──
# 저점 높이기는 120일씩 두 구간(총 1년)을 비교한다 — 60일 대비로는 장기 하락 중의
# 중간 반등도 통과해 계단식 하락의 계단참을 바닥으로 오인했다.
HIGHER_LOW_WINDOW = 120
MIN_BARS = HIGHER_LOW_WINDOW * 2
YEAR_WINDOW = 252
RECENT_LOW_WINDOW = 20
BOX_WINDOW = 60
MAX_BOX_RANGE = 0.3
EXHAUSTION_CAP_DAYS = 120
# 횡보·조정 탭 진입 조건 (frontend/app/discover/page.tsx MIN/MAX_DRAWDOWN)
MIN_DRAWDOWN = 20.0
MAX_DRAWDOWN = 60.0

_LOOKBACK_DAYS = 1095  # 3년 — 조정폭 계산 기준


def _clamp01(x: float) -> float:
    return min(1.0, max(0.0, x))


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs)


def _atr(bars: list[dict], period: int) -> float:
    window = bars[-(period + 1):]
    trs = []
    for i in range(1, len(window)):
        high, low = window[i]["high"], window[i]["low"]
        prev_close = window[i - 1]["close"]
        trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return _mean(trs)


def evaluate_watch(bars: list[dict]) -> dict:
    """일봉(date 오름차순, open/high/low/close/volume) 리스트를 평가.

    qualified=True는 횡보·조정 탭에 실제로 노출되는 조건과 동일:
    조정폭 20~60% + 하드 필터 3종 통과. 미통과 시 reason에 어떤 관문에서
    걸렸는지 남겨 화면에서 "무엇이 부족한지"를 보여줄 수 있게 한다.
    """
    status: dict = {
        "qualified": False,
        "reason": None,
        "drawdown": None,
        "in_drawdown_band": None,
        "no_new_low": None,
        "box_ok": None,
        "score": None,
        "days_since_low": None,
        "vcp": None,
        "higher_lows": None,
        "volume_dry": None,
        "aligned_mas": None,
        "volume_trigger": None,
    }

    if len(bars) < MIN_BARS:
        status["reason"] = f"데이터 부족 ({len(bars)}봉 < {MIN_BARS}봉)"
        return status

    closes = [b["close"] for b in bars]
    high3y = max(closes)
    last_close = closes[-1]
    drawdown = (high3y - last_close) / high3y * 100 if high3y > 0 else 0.0
    status["drawdown"] = round(drawdown, 2)
    status["in_drawdown_band"] = MIN_DRAWDOWN <= drawdown <= MAX_DRAWDOWN

    year_bars = bars[-min(YEAR_WINDOW, len(bars)):]
    lows = [b["low"] for b in year_bars]

    # 하드 필터 1 — 최근 20거래일 내 52주 신저가 갱신 없음
    recent_lows = lows[-RECENT_LOW_WINDOW:]
    prior_lows = lows[:-RECENT_LOW_WINDOW]
    status["no_new_low"] = min(recent_lows) >= min(prior_lows)

    # 하드 필터 2 — 최근 60거래일 박스폭 (최고−최저)/최저 ≤ 30%
    box_bars = bars[-BOX_WINDOW:]
    box_high = max(b["high"] for b in box_bars)
    box_low = min(b["low"] for b in box_bars)
    status["box_ok"] = box_low > 0 and (box_high - box_low) / box_low <= MAX_BOX_RANGE

    # 하드 필터 3 — 유동성 (거래량 평균 0이면 계산 불가)
    volumes = [b["volume"] for b in bars]
    volumes_ok = _mean(volumes[-20:]) > 0 and _mean(volumes[-60:-20]) > 0

    failed = []
    if not status["in_drawdown_band"]:
        failed.append(f"조정폭 {drawdown:.0f}% (기준 {MIN_DRAWDOWN:.0f}~{MAX_DRAWDOWN:.0f}%)")
    if not status["no_new_low"]:
        failed.append("최근 20일 내 신저가 갱신 중")
    if not status["box_ok"]:
        failed.append("60일 박스폭 30% 초과 (아직 횡보 아님)")
    if not volumes_ok:
        failed.append("거래량 데이터 이상")
    if failed:
        status["reason"] = " · ".join(failed)
        return status

    # ── 매수 매력도 점수 (통과 종목만) ──
    year_low = min(lows)
    last_low_idx = len(lows) - 1 - lows[::-1].index(year_low)
    days_since_low = len(lows) - 1 - last_low_idx
    exhaustion_score = _clamp01(days_since_low / EXHAUSTION_CAP_DAYS)

    atr60 = _atr(bars, 60)
    vcp_ratio = _atr(bars, 20) / atr60 if atr60 > 0 else 1.0
    vcp_score = _clamp01((1 - vcp_ratio) / 0.4)

    recent_low = min(b["low"] for b in bars[-HIGHER_LOW_WINDOW:])
    prior_low = min(b["low"] for b in bars[-HIGHER_LOW_WINDOW * 2 : -HIGHER_LOW_WINDOW])
    higher_lows = recent_low > prior_low

    vol_ratio = _mean(volumes[-20:]) / _mean(volumes[-60:-20])
    if vol_ratio < 0.5:
        volume_dry_score = _clamp01((vol_ratio - 0.2) / 0.3)
    elif vol_ratio <= 0.8:
        volume_dry_score = 1.0
    else:
        volume_dry_score = _clamp01((1.2 - vol_ratio) / 0.4)

    score = (
        0.3 * exhaustion_score
        + 0.25 * vcp_score
        + 0.25 * (1.0 if higher_lows else 0.0)
        + 0.2 * volume_dry_score
    )

    sma5 = _mean(closes[-5:])
    sma20 = _mean(closes[-20:])
    sma60 = _mean(closes[-60:])
    aligned_mas = last_close > sma5 > sma20 > sma60
    if aligned_mas:
        score += 0.1

    volume_trigger = volumes[-1] >= 2 * _mean(volumes[-90:])
    if volume_trigger:
        score += 0.1

    status.update({
        "qualified": True,
        "score": round(min(1.0, score), 4),
        "days_since_low": days_since_low,
        "vcp": vcp_ratio <= 0.8,
        "higher_lows": higher_lows,
        "volume_dry": volume_dry_score >= 0.6,
        "aligned_mas": aligned_mas,
        "volume_trigger": volume_trigger,
    })
    return status


def _fetch_bars(db: ScreenerDB, ticker: str, market: str, today: date) -> list[dict]:
    cutoff = (today - timedelta(days=_LOOKBACK_DAYS)).isoformat()
    rows: list[dict] = []
    page = 1000
    start = 0
    while True:
        result = (
            db.client.table("stock_price_history")
            .select("date, open, high, low, close, volume")
            .eq("ticker", ticker)
            .eq("market", market)
            .gte("date", cutoff)
            .order("date")
            .range(start, start + page - 1)
            .execute()
        )
        data = result.data or []
        rows.extend(data)
        if len(data) < page:
            break
        start += page
    return [
        {
            "date": r["date"],
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "volume": float(r["volume"]),
        }
        for r in rows
    ]


def run_watchlist(db: ScreenerDB, today: date) -> None:
    if not WATCHLIST:
        return
    print("감시 종목 평가 중...", flush=True)
    for ticker, market, name in WATCHLIST:
        try:
            bars = _fetch_bars(db, ticker, market, today)
            status = evaluate_watch(bars)

            db.client.table("watchlist_status").upsert({
                "ticker": ticker,
                "market": market,
                "name": name,
                "date": today.isoformat(),
                **status,
            }).execute()

            label = "통과 ✓" if status["qualified"] else f"대기 ({status['reason']})"
            print(f"  {name}({ticker}): {label}", flush=True)
        except Exception as exc:  # noqa: BLE001
            # 테이블 미생성 등으로 실패해도 파이프라인 본체는 계속 진행
            print(f"  {name}({ticker}) 평가 실패: {exc}", flush=True)
