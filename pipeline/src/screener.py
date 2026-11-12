from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd

from .indicators import atr, is_trending_up, rsi, sma

MIN_HISTORY_DAYS = 85
LONG_TERM_WINDOW = 60
SMA200_WINDOW = 200
SHORT_TERM_WINDOW = 5
MID_TERM_WINDOW = 20
RSI_WINDOW = 14
RSI_LOW = 40
RSI_HIGH = 60  # raised from 55: 10-20MA zone stocks haven't cooled as far as 20MA-zone stocks
RSI_DIRECTION_LOOKBACK = 3
IMPULSE_LOOKBACK_DAYS = 60
IMPULSE_MIN_GAIN = 0.15  # 선행 임팩트: 최근 60거래일 수익률 +15% 이상인 종목만
PULLBACK_LOWER_TOLERANCE = 0.05  # sma20 대비 5%까지 하회 허용 — 대형주는 변동성이 낮아
# 좁은 눌림목 구간에 잘 걸리지 않아 하한을 sma20 아래로 넓힌다.
#
# **상한(sma10)은 2026-11-11에 없앴다 — 백테스트가 거꾸로라고 말했다.**
# 원래 조건은 `sma20*0.95 <= 종가 <= sma10`이라는 좁은 띠였는데, 17,570건을 방향별로
# 갈라 보니 띠를 **위로** 벗어난 쪽이 띠 안보다 꾸준히 나았다:
#     구간 안      6,670건  -0.027R  실수익 평균 -0.1%
#     sma10 위    10,113건  +0.056R  실수익 평균 +0.3%   종목 A조 +0.067 · B조 +0.046
#     하단 이탈      787건  -0.015R  실수익 평균 -0.1%   종목 A조 -0.070 · B조 +0.037
# 위쪽은 표본 1만 건에 종목을 반으로 갈라도 양쪽 다 플러스고, 아래쪽은 787건에 부호가
# 뒤집혀 아무 말도 못 한다. 그래서 **상한만 없애고 하한은 남겼다** — 조건을 통째로
# 빼면 근거 없는 쪽까지 같이 빼게 되고, 눌림목 스크리너가 눌림목을 안 보게 된다.
# 근거와 재현 방법은 docs/backtest-guide.md와 frontend/research/backtestPullbackCriteria.ts.
BOUNCE_LOOKBACK = MID_TERM_WINDOW  # 조정 시작점(H)/조정 저점(L)을 재는 창 — 눌림구간과 같은 스케일
BOUNCE_VOLUME_WINDOW = MID_TERM_WINDOW
MAX_PULLBACK_RETRACEMENT = 0.5  # 직전 상승폭(IMPULSE_LOOKBACK_DAYS 구간 저→고)의 50% 넘게
# 되돌리면 조정이 아니라 추세 하락(매매의 기술) — SMA20*0.95 하한은 이평선 대비 상대
# 위치일 뿐이라 "얼마나 깊게 빠졌나"를 직접 재지 못해 이 조건으로 보완한다.
ATR_WINDOW = 14
MAX_VOLATILITY_RATIO = 0.10  # ATR14/종가가 10% 넘으면 변동성 과다로 제외. 0.10인 이유:
# frontend/lib/risk.ts의 MAX_STOP_DISTANCE_PCT(0.15)가 손절을 entry-1.5*ATR로 잡을 때
# ATR/entry > 0.10이면 손절폭이 15%를 넘어 화면에 아예 안 뜬다 — 여기서 미리 걸러
# "조건은 통과했는데 손절이 안 나오는" 종목을 후보 단계에서부터 줄인다(온투이노베이션
# 2026-08-26 사례: RSI·거래량·눌림구간은 다 통과했지만 ATR이 지나치게 커서 손절이
# 진입가의 -24.9%까지 벌어졌었다).


# 조건별 실패 라벨 — DB(failed_criteria text[])에 그대로 저장되어 프론트에 표시된다.
CRITERION_SMA200 = "200일선 아래"
CRITERION_LONG_TREND = "장기 추세 꺾임"
CRITERION_PULLBACK_ZONE = "눌림 구간 하단 이탈"
CRITERION_RSI_RANGE = "RSI 범위 밖"
CRITERION_RSI_RISING = "RSI 하락 중"
CRITERION_IMPULSE = "선행 상승 부족"
CRITERION_BOUNCE = "반등 미확인"
CRITERION_PULLBACK_DEPTH = "조정 과다"
CRITERION_VOLATILITY = "변동성 과다"


@dataclass
class PullbackEvaluation:
    passed: bool
    failed: list[str] = field(default_factory=list)
    impulse_gain: float = 0.0  # 최근 60거래일 수익률 — 근접 종목 랭킹 타이브레이커


def evaluate_pullback(
    close: pd.Series,
    volume: pd.Series,
    high: pd.Series,
    low: pd.Series,
    open_: pd.Series,
    *,
    require_sma200: bool = False,
) -> PullbackEvaluation | None:
    """모든 눌림목 조건을 평가해 미달 조건 목록을 반환한다.

    통과/탈락 이분법 대신 "어떤 조건이 몇 개 미달인지"를 남겨, 전 조건 통과
    종목이 없는 날에도 가장 근접한 상위 종목을 랭킹으로 보여줄 수 있게 한다.
    데이터가 부족해 평가 자체가 불가능하면 None (랭킹 대상에서 제외).
    """
    if len(close) < MIN_HISTORY_DAYS:
        return None

    sma20 = sma(close, MID_TERM_WINDOW)
    sma60 = sma(close, LONG_TERM_WINDOW)
    rsi14 = rsi(close, RSI_WINDOW)

    latest_close = close.iloc[-1]
    latest_sma20 = sma20.iloc[-1]
    latest_sma60 = sma60.iloc[-1]
    latest_rsi = rsi14.iloc[-1]

    if pd.isna(latest_sma60) or pd.isna(latest_rsi) or pd.isna(latest_sma20):
        return None

    failed: list[str] = []

    # Require close above 200-day MA to exclude long-term downtrend stocks (KR + US).
    if require_sma200:
        sma200 = sma(close, SMA200_WINDOW)
        latest_sma200 = sma200.iloc[-1]
        if pd.isna(latest_sma200) or latest_close <= latest_sma200:
            failed.append(CRITERION_SMA200)

    long_term_up = is_trending_up(sma60, lookback=SHORT_TERM_WINDOW) and latest_close > latest_sma60
    if not long_term_up:
        failed.append(CRITERION_LONG_TREND)

    # 하한만 본다 — 위쪽 경계는 2026-11-11에 없앴다(위 PULLBACK_LOWER_TOLERANCE 주석 참조).
    pullback_lower_bound = latest_sma20 * (1 - PULLBACK_LOWER_TOLERANCE)
    if latest_close < pullback_lower_bound:
        failed.append(CRITERION_PULLBACK_ZONE)

    if not (RSI_LOW <= latest_rsi <= RSI_HIGH):
        failed.append(CRITERION_RSI_RANGE)

    if not (latest_rsi > rsi14.iloc[-1 - RSI_DIRECTION_LOOKBACK]):
        failed.append(CRITERION_RSI_RISING)

    # **"조정 중 거래량 감소" 조건은 2026-11-11에 없앴다 — 성과와 반대 방향이었다.**
    # 충족 7,578건 -0.008R · 미달 9,992건 +0.044R (차이 -0.052R)이고, 구간을 반으로 갈라도
    # 탐색 -0.017R / 검증 -0.050R로 부호가 같았다. 『매매의 기술』 매수 제2원칙을 옮긴
    # 조건이었지만 이 유니버스·이 보유 기간에서는 좋은 후보를 깎아내리고 있었다.
    # pattern_discovery.py가 2026-09-14에 고친 것과 **같은 종류의 오류**다(거래량 점수가
    # 성과와 반대 방향). 거래량은 여전히 반등 확인 조건에서 본다 — 거기서는 '방향'과
    # 함께 보므로(양봉 + 거래량 증가) 이 문제가 없다.

    # 선행 임팩트: 눌림목 이전에 강한 상승 파동이 있었던 종목만.
    impulse_gain = float(latest_close / close.iloc[-1 - IMPULSE_LOOKBACK_DAYS] - 1)
    if impulse_gain < IMPULSE_MIN_GAIN:
        failed.append(CRITERION_IMPULSE)

    # 조정 깊이 상한 — 직전 상승폭(같은 IMPULSE_LOOKBACK_DAYS 구간의 저→고)의 50%를
    # 넘게 되돌리면 조정이 아니라 추세 하락으로 본다(매매의 기술). SMA20*0.95 하한은
    # 이평선 대비 상대 위치일 뿐이라, 급등 후 급락한 종목이 SMA20까지 빠르게 내려오면
    # 이 조건 없이는 걸러지지 않았다.
    impulse_window = close.iloc[-IMPULSE_LOOKBACK_DAYS:]
    impulse_low = impulse_window.min()
    impulse_high = impulse_window.max()
    if impulse_high > impulse_low:
        retracement = (impulse_high - latest_close) / (impulse_high - impulse_low)
        if retracement > MAX_PULLBACK_RETRACEMENT:
            failed.append(CRITERION_PULLBACK_DEPTH)

    # 반등 확인 — 『매매의 기술』 50% 룰. 직전 하락폭(조정 시작 고가 H → 조정 저점 L)의
    # 절반을 되돌려야 진입("직전 매도자 전체를 손실로 만들 만큼 강한 매수세"), 거래량
    # 증가 + 양봉을 함께 요구한다(거래량은 느는데 음봉이면 오히려 매도 신호 — 매도 제2원칙).
    # 이전 조건("종가 > 전일 고가")은 전일 봉 크기에 따라 난이도가 들쭉날쭉했다
    # (도지면 너무 쉽고 장대음봉이면 사실상 불가능) — 조정 폭 대비 상대적인 이 기준으로 교체.
    bounce_h = high.iloc[-1 - BOUNCE_LOOKBACK : -1].max()
    bounce_l = low.iloc[-1 - BOUNCE_LOOKBACK : -1].min()
    recovered_half = latest_close >= bounce_l + 0.5 * (bounce_h - bounce_l)
    volume_rising = volume.iloc[-1] > volume.iloc[-1 - BOUNCE_VOLUME_WINDOW : -1].mean()
    bullish = latest_close > open_.iloc[-1]
    if not (recovered_half and volume_rising and bullish):
        failed.append(CRITERION_BOUNCE)

    # 변동성 과다 — ATR14/종가가 10%를 넘으면 제외. 다른 조건(추세·눌림구간·RSI·거래량·
    # 임팩트·반등)은 전부 "가격 위치"만 볼 뿐 "이 종목이 하루에 얼마나 흔들리는가"는
    # 안 본다. 변동성이 큰 종목일수록 오히려 임팩트·반등 조건은 쉽게 만족시키면서
    # 정작 손절은 감당 못 할 만큼 멀어진다(온투이노베이션 사례).
    latest_atr = atr(high, low, close, ATR_WINDOW).iloc[-1]
    if pd.isna(latest_atr) or (latest_atr / latest_close) > MAX_VOLATILITY_RATIO:
        failed.append(CRITERION_VOLATILITY)

    return PullbackEvaluation(passed=not failed, failed=failed, impulse_gain=impulse_gain)


def passes_pullback_filter(
    close: pd.Series,
    volume: pd.Series,
    high: pd.Series,
    low: pd.Series,
    open_: pd.Series,
    *,
    require_sma200: bool = False,
) -> bool:
    ev = evaluate_pullback(close, volume, high, low, open_, require_sma200=require_sma200)
    return ev is not None and ev.passed
