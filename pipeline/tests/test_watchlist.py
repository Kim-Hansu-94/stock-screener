from pipeline.src.watchlist import MIN_BARS, evaluate_watch


def _bar(i: int, close: float, spread: float = 1.0, volume: float = 1000.0) -> dict:
    return {
        "date": f"D{i:04d}",
        "open": close,
        "high": close + spread / 2,
        "low": close - spread / 2,
        "close": close,
        "volume": volume,
    }


def _base_forming_bars() -> list[dict]:
    """고점 100 → 55까지 하락 → 저점 다지며 완만히 상승하는 횡보 베이스."""
    bars: list[dict] = []
    i = 0
    # 3년 고점 구간
    for _ in range(50):
        bars.append(_bar(i, 100.0, spread=2.0))
        i += 1
    # 하락 구간: 100 → 55
    for k in range(100):
        bars.append(_bar(i, 100.0 - 0.45 * (k + 1), spread=2.0))
        i += 1
    # 횡보 베이스: 저점 55 부근에서 완만히 상승, 변동성·거래량 수축
    for k in range(250):
        close = 56.0 + min(3.0, k * 0.02)
        volume = 1000.0 if k < 210 else 600.0  # 최근 20일 거래량 소진 (직전 40일 대비 0.6)
        bars.append(_bar(i, close, spread=0.8, volume=volume))
        i += 1
    return bars


def test_insufficient_bars_reports_reason():
    bars = [_bar(i, 100.0) for i in range(MIN_BARS - 1)]
    status = evaluate_watch(bars)
    assert status["qualified"] is False
    assert "데이터 부족" in status["reason"]


def test_free_fall_rejected_by_new_low_filter():
    # 꾸준한 하락 지속: 마지막 봉이 항상 52주 신저가 → 하드 필터 1에 걸려야 한다
    bars = [_bar(i, 300.0 - i * 0.5) for i in range(400)]
    status = evaluate_watch(bars)
    assert status["qualified"] is False
    assert status["no_new_low"] is False
    assert "신저가" in status["reason"]


def test_shallow_drawdown_rejected_by_band():
    # 조정폭 ~10%: 횡보이긴 하나 "조정 종목" 범위(20~60%) 미달
    bars = [_bar(i, 100.0, spread=1.0) for i in range(200)]
    bars += [_bar(200 + i, 90.0, spread=1.0) for i in range(200)]
    status = evaluate_watch(bars)
    assert status["qualified"] is False
    assert status["in_drawdown_band"] is False
    assert "조정폭" in status["reason"]


def test_formed_base_qualifies_with_signals():
    status = evaluate_watch(_base_forming_bars())
    assert status["qualified"] is True, status["reason"]
    assert status["in_drawdown_band"] is True
    assert status["no_new_low"] is True
    assert status["box_ok"] is True
    assert 0.0 < status["score"] <= 1.0
    assert status["higher_lows"] is True
    assert status["volume_dry"] is True
