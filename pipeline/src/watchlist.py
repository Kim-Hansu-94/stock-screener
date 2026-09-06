"""보유/관심 종목 감시.

횡보·조정 스크리너와 동일한 기준(frontend/lib/opportunityScore.ts의 하드 필터·
매수 매력도 점수를 그대로 포팅)으로 감시 종목을 매일 평가해 watchlist_status에
저장한다. 결과는 홈 화면 "감시 종목" 카드(WatchlistCard)에 표시된다.

숫자 상수를 바꿀 때는 frontend/lib/opportunityScore.ts와 반드시 함께 바꿀 것.
"""

from __future__ import annotations

from datetime import date, timedelta

from .db import ScreenerDB

# (ticker, market, 표시명). 코드에 박아두는 기본 감시 종목 — run_watchlist가 이
# 상수와 watchlist_tickers 테이블을 합쳐서 평가한다.
#
# 지금은 비어 있고, 그게 정상이다. 감시 종목은 전부 사이트에서 직접 추가·삭제하는
# 게 낫다(배포 없이 되고, 매집 감시/포지션 관리 구분도 화면에서만 가능하다).
# 예전엔 SK하이닉스가 여기 박혀 있었는데, 사이트에서 포지션 관리로 등록한 뒤에도
# 이 상수 때문에 파이프라인이 계속 매집 감시 대상으로 평가했다 — 포지션 관리에서
# 삭제하면 매집 감시에 되살아나는 유령이 되므로 지웠다(2026-09-06).
WATCHLIST: list[tuple[str, str, str]] = []

# ── frontend/lib/opportunityScore.ts 와 동일한 상수 ──
# 저점 높이기는 120일씩 두 구간(총 1년)을 비교한다 — 60일 대비로는 장기 하락 중의
# 중간 반등도 통과해 계단식 하락의 계단참을 바닥으로 오인했다.
HIGHER_LOW_WINDOW = 120
MIN_BARS = HIGHER_LOW_WINDOW * 2
YEAR_WINDOW = 252
RECENT_LOW_WINDOW = 20
BOX_WINDOW = 60
MAX_BOX_RANGE = 0.3
# 120일(6개월)→60일. 저점 이후 "더 오래 기다릴수록" 계속 점수를 얹어주는 구간이
# 넓으면, 막 저점을 다지기 시작한(그래서 아직 덜 오른) 종목보다 몇 달째 조용한
# (이미 어느 정도 오른) 종목이 구조적으로 항상 높은 점수를 받는다. 2개월만
# 조용해도 매도 소진은 만점으로 보고, "지금 막 방향을 트는지"는 아래 정배열·
# 거래량트리거 보너스가 가리게 한다(frontend/lib/opportunityScore.ts와 동일).
EXHAUSTION_CAP_DAYS = 60
# 횡보·조정 탭 진입 조건 (frontend/app/discover/page.tsx MIN/MAX_DRAWDOWN)
MIN_DRAWDOWN = 20.0
MAX_DRAWDOWN = 60.0
# 거래량 급증 판정 배수(90일 평균 대비). aligned_mas 보너스와 detect_box_breakout이
# 공유한다.
VOLUME_TRIGGER_MULT = 2

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

    # 하드 필터 2 — 최근 60거래일 박스폭 (최고−최저)/최저 ≤ 30%. 일중 고가·저가
    # 기준이라 하루 급등락(뉴스·실적 갭)만으로도 이후 60일 내내 미달로 남을 수
    # 있다 — 실제 계산값을 reason에 남겨야 "얼마나 벗어났는지" 판단할 수 있다.
    box_bars = bars[-BOX_WINDOW:]
    box_high = max(b["high"] for b in box_bars)
    box_low = min(b["low"] for b in box_bars)
    box_range_pct = (box_high - box_low) / box_low * 100 if box_low > 0 else None
    status["box_ok"] = box_range_pct is not None and box_range_pct <= MAX_BOX_RANGE * 100

    # 하드 필터 3 — 유동성 (거래량 평균 0이면 계산 불가)
    volumes = [b["volume"] for b in bars]
    volumes_ok = _mean(volumes[-20:]) > 0 and _mean(volumes[-60:-20]) > 0

    failed = []
    if not status["in_drawdown_band"]:
        failed.append(f"조정폭 {drawdown:.0f}% (기준 {MIN_DRAWDOWN:.0f}~{MAX_DRAWDOWN:.0f}%)")
    if not status["no_new_low"]:
        failed.append("최근 20일 내 신저가 갱신 중")
    if not status["box_ok"]:
        range_str = f"{box_range_pct:.0f}%" if box_range_pct is not None else "계산 불가"
        failed.append(f"60일 박스폭 {range_str} (기준 {MAX_BOX_RANGE * 100:.0f}% 이하, 아직 횡보 아님)")
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
        score += 0.15

    volume_trigger = volumes[-1] >= VOLUME_TRIGGER_MULT * _mean(volumes[-90:])
    if volume_trigger:
        score += 0.15

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


def detect_box_breakout(bars: list[dict]) -> bool:
    """박스 상단(오늘 이전 60거래일 최고가) 돌파 + 거래량 확인.

    횡보·조정 탭(3년 고점 대비 20~60% 빠져 아직 상승 추세가 확인 안 된 종목)에서
    "오르기 시작했다"를 판정할 때 이평 정배열(aligned_mas)보다 이걸 쓰는 이유:
    정배열은 좁은 박스 안에서 노이즈로도 순서가 맞아떨어질 수 있는 반면, 이건
    실제로 저항(박스 상단)을 가격이 뚫고 나갔다는 직접적인 증거다(와이코프
    Sign of Strength·다바스 박스 돌파와 같은 개념). VCP(정배열 포함)는 원래
    "이미 상승 추세가 증명된 종목"의 재상승 신호로 만들어진 개념이라, 상승
    이력이 없는 이런 종목에는 신뢰도가 더 필요하다.

    watchlist_status(감시 종목)는 여전히 aligned_mas를 쓴다 — 그쪽은 이미
    장기 상승 추세가 있는 종목이 많아 정배열 자체의 신뢰도가 이 종목군보다 높다.
    """
    if len(bars) <= BOX_WINDOW:
        return False
    prior_box = bars[-(BOX_WINDOW + 1):-1]
    prior_high = max(b["high"] for b in prior_box)
    last = bars[-1]
    volumes = [b["volume"] for b in bars]
    avg_volume = _mean(volumes[-90:])
    volume_ok = avg_volume > 0 and volumes[-1] >= VOLUME_TRIGGER_MULT * avg_volume
    return last["close"] > prior_high and volume_ok


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


def get_combined_watchlist(db: ScreenerDB) -> list[tuple[str, str, str]]:
    """코드의 기본 목록(WATCHLIST) + 사이트에서 직접 추가한 목록(watchlist_tickers)을 합친다.

    같은 (market, ticker)면 사이트 쪽 이름으로 덮어써 최신 표기를 따른다.
    main.py가 평가 전에 히스토리 보완 대상을 고르는 데도 이 목록을 그대로 재사용한다
    (감시 종목은 정규 스크리닝 유니버스 밖의 임의 종목일 수 있어 일봉이 없을 수 있음).
    """
    combined: dict[tuple[str, str], tuple[str, str, str]] = {
        (market, ticker): (ticker, market, name) for ticker, market, name in WATCHLIST
    }
    for ticker, market, name in db.get_watchlist_tickers():
        combined[(market, ticker)] = (ticker, market, name)
    return list(combined.values())


def run_watchlist(db: ScreenerDB, today: date) -> None:
    combined = get_combined_watchlist(db)

    # 목록이 비면 정리(prune)까지 건너뛴다 — prune_watchlist_status([])는
    # watchlist_status를 통째로 지운다. 그런데 이 "비었음"은 진짜 빈 것일 수도,
    # get_watchlist_tickers가 조회에 실패해 빈 목록을 돌려준 것일 수도 있어
    # 구분이 안 된다(그 메서드는 예외를 삼키고 []를 반환한다). 예전엔 WATCHLIST
    # 상수에 종목이 박혀 있어 이 경우가 아예 없었지만, 이제 상수가 비어 있으므로
    # 일시적 조회 실패 한 번에 전체 평가 결과가 날아갈 수 있다. 낡은 행이 잠시
    # 남는 쪽이 훨씬 덜 해로우므로 아무것도 안 한다 — 다음 실행에서 조회가
    # 성공하면 그때 정상적으로 정리된다.
    if not combined:
        print("감시 종목 없음 — 평가·정리 모두 건너뜀", flush=True)
        return

    db.prune_watchlist_status([(market, ticker) for ticker, market, _name in combined])

    # 분할매수 컨셉: "오늘 통과했다/안했다"라는 하루짜리 신호가 아니라, 조건을
    # 계속 충족하는 동안을 하나의 "매집 구간"으로 본다. 어제도 통과 상태였다면
    # qualified_since를 그대로 이어가고, 오늘 새로 통과했거나 끊겼다 다시
    # 통과했다면 오늘 날짜로 새로 시작한다.
    previous = db.get_watchlist_status_rows()

    print("감시 종목 평가 중...", flush=True)
    for ticker, market, name in combined:
        try:
            bars = _fetch_bars(db, ticker, market, today)
            status = evaluate_watch(bars)

            prev = previous.get((market, ticker))
            if status["qualified"]:
                still_continuous = bool(prev and prev.get("qualified") and prev.get("qualified_since"))
                status["qualified_since"] = prev["qualified_since"] if still_continuous else today.isoformat()
            else:
                status["qualified_since"] = None

            # 이평 정배열이 이어지는 구간의 시작일도 같은 방식으로 이어받는다 —
            # "며칠째 매집 구간인지"와 별개로 "며칠째 상승 전환 상태인지"를 보여주기
            # 위함(opportunity_snapshot의 breakout_since와 같은 목적, 다른 신호).
            if status["aligned_mas"]:
                still_aligned = bool(prev and prev.get("aligned_mas") and prev.get("aligned_since"))
                status["aligned_since"] = prev["aligned_since"] if still_aligned else today.isoformat()
            else:
                status["aligned_since"] = None

            db.client.table("watchlist_status").upsert({
                "ticker": ticker,
                "market": market,
                "name": name,
                "date": today.isoformat(),
                **status,
            }).execute()

            if status["qualified"]:
                days = (today - date.fromisoformat(status["qualified_since"])).days + 1
                label = f"통과 ✓ (매집 구간 {days}일째)"
            else:
                label = f"대기 ({status['reason']})"
            print(f"  {name}({ticker}): {label}", flush=True)
        except Exception as exc:  # noqa: BLE001
            # 테이블 미생성 등으로 실패해도 파이프라인 본체는 계속 진행
            print(f"  {name}({ticker}) 평가 실패: {exc}", flush=True)
