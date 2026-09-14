"""Gold Standard 바닥 특성 기반 후보 종목 발굴 — 파이프라인 사전 계산 모듈 v2.

v2 개선 사항:
  - 하락률 기준: 5개월 고점 → 52주 최고가 (KIS 1년치 이력 직접 사용, lookback_days=380)
  - 가중치 재조정: 하락률 0.3 / 소진일수 0.4 / 거래량 0.3
  - VCP 보너스: ATR10 / ATR50 ≤ 0.6 이면 +0.10점 (변동성 압축)
  - 이평선 정배열 보너스: 현재가 > SMA5 > SMA10 > SMA20 이면 +0.10점
  - NumPy 벡터 연산으로 내부 지표 계산 최적화
  - MIN_SCORE 미달 종목 자동 드롭 후 상위 TOP_N 반환

v3 (2026-09-14, 『매매의 기술』 근거):
  - 거래량 트리거에 **봉 방향 조건** 추가 — 대량거래 + (양봉 또는 십자형)일 때만
    `volume_triggered`. 예전에는 거래량 2배만 보고 투매(대량거래 장대음봉)에도
    ⚡ 배지가 붙었다 (`_is_volume_trigger_today` 주석 참고)
  - 추천 결과에 집계용 원본 수치(`drawdown_pct`·`days_since_low`·`vol_ratio`·
    `vcp`·`ma_align`)를 함께 실어 `recommendation_history`에 남긴다 — 나중에
    "어떤 특성의 후보가 잘 맞았나"로 성적을 쪼개려면 추천 시점 수치가 필요하다

v4 (2026-09-14, **백테스트 검증 — 결론: 채점 공식은 v3 그대로 둔다**):

  두 책에서 뽑은 개선안 네 가지를 3년 워크포워드 재생으로 판정했다
  (`pipeline/research/backtest_pattern_features.py`, 표본 694건 + 하락률 스윕
  10,433건). **네 가지 모두 채택되지 않았다.** 아래는 "이미 시험해 봤고 왜
  안 됐는지"의 기록이다 — 같은 아이디어를 다시 꺼내기 전에 읽을 것.

  **① 만점 지점 당기기 (하락률 90%→65%, 소진일수 60일→50일) — 기각**
  "더 깊게·더 오래 가도 성과가 안 좋아지는데 왜 계속 가산하나"가 근거였다.
  당겨 보니 **점수가 변별력을 잃었다**: 70점 이상이 87건 → 457건(표본의 65%)이
  되어 구간 구분이 무의미해졌고, 나쁜 구간은 사라진 게 아니라 60~69점으로
  내려갔다(중간값 -1.46%·승률 47.4%). 고치려던 1~5위 성적은 중간값
  0.00% → **-6.22%**, 승률 49.6% → **44.6%**로 더 나빠졌다.

  **② 저점 높이기 보너스 (+0.10) — 기각, 관측만 유지**
  `_is_higher_low` 주석 참고. 관측에서는 가장 뚜렷했으나(중간값 11.72% vs 8.62%)
  가산점을 주자 해당 종목이 272 → 398건으로 늘며 우위가 사라졌다.

  **③ 이평 정배열 보너스 제거 — 기각(되돌림)**
  관측은 분명했다 — 정배열 종목이 오히려 나빴다(60거래일 중간값 5.86%·승률
  56.5% vs 정배열 아님 10.84%·59.3%). 그래서 ①②를 되돌린 뒤 ③만 남겨
  재검증했는데(표본 674건), **전체가 나아지지 않았다**: 순위 1~5위 중간값
  0.00% → -2.25%·승률 49.6% → 47.3%, 60~69점 구간 20.77% → 12.44%,
  2025년 13.82% → 12.52%. 나아진 구간(6~10위 2.19 → 6.78)과 나빠진 구간이
  섞여 순효과가 없다.

  **결정적인 단서는 저점 높이기 쪽에서 나왔다.** ③만 뺐을 뿐인데 원본의
  저점 높이기 우위(11.72%·59.9% vs 8.62%·57.8%)가 **역전됐다**
  (7.56%·55.9% vs 10.60%·60.1%). 보너스 하나를 건드리면 상위 20에 뽑히는
  종목 구성이 통째로 바뀌고, 그러면 다른 조건의 관측값까지 같이 뒤집힌다.
  즉 **"정배열 종목이 나빴다"는 관측은 "정배열 보너스를 빼면 좋아진다"의
  근거가 되지 못한다.** 근거가 없으므로 되돌렸다.

  **④ 하락 속도 / 50% 룰 — 채택 안 함**
  책과 반대로 급락한 종목이 가장 나빴고, 50% 룰은 승률 56.6 vs 56.2로
  차이가 없었다.

  **검증돼서 그대로 둔 것 — `MIN_DRAWDOWN`(55%)**
  하한을 25%까지 낮춰 재생해 보니 45~55% → 55~65%에서 60거래일 중간값이
  5.92% → 14.06%로 뛰고 승률도 58.0% → 64.2%로 올랐다(250거래일도 같은 자리에서
  33.18 → 65.45). 계단이 정확히 55%에 있다. 표본 1439/749건에 쏠림 0.7/0.9%로
  이번 작업에서 가장 깨끗한 증거다. 올릴 근거도 없다 — 65~75%는 중간값이 9.68로
  오히려 떨어지고 85%+는 25종목에 최다종목 21.6%라 못 믿는다.

  **그래서 이번 작업이 남긴 것**은 채점 변경이 아니라 두 가지다:
  (1) 3년을 되돌려 돌리는 검증 도구, (2) `recommendation_history`에 관측 특성을
  남기는 기록 경로(`higher_low` 추가 — 점수에는 안 들어간다).

  **남은 숙제**: "점수 상위가 오히려 나쁘다"(1~5위 중간값 0.00% vs 11위 이하
  12.66%)는 만점 지점으로도 보너스 제거로도 고쳐지지 않았다. 점수 구성 요소가
  성과와 단조 관계가 아니라서 생기는 문제이고, 선발 방식 자체를 바꾸는 별도
  설계가 필요하다.

  ⚠️ 이 근거들은 2024~2025년 표본의 **구간 간 상대 비교**다. 유니버스가 오늘
  시점 목록이라 상장폐지 종목이 빠져 있어(생존 편향) 절대 수익률은 믿을 수 없다.

v5 (2026-09-14, **소진일수 커트라인 15 → 30일**):

  v4에서 개선안 네 가지가 전부 기각된 뒤, "점수가 높을수록 좋아야 정상인데 지금은
  상위권이 오히려 나쁘다"는 숙제를 **한 번에 하나씩** 풀기로 했다. 그 첫 번째다.

  **근거 — 15~29일만 마이너스다**

      구간       n    중간값     승률   최다종목%
      15~29일    50   -3.96%   44.0%      6.0
      30~44일    35   12.44%   54.3%      5.7
      45~59일    61   12.25%   65.6%      1.6
      60일 이상 548   10.43%   59.5%      2.0

  694건 중 유일하게 마이너스인 구간이고, 쏠림도 낮다(6.0%). 30일만 넘으면 그 뒤로는
  거의 평평하므로 **이건 가산점이 아니라 커트라인의 성격**이다.

  **왜 하드 필터인가가 중요하다.** v4에서 실패한 네 가지는 전부 가산점이었고,
  살아남은 하나(`MIN_DRAWDOWN` 55%)는 하드 필터였다. 가산점은 상위 20에 뽑히는 종목
  구성을 바꿔 관측을 무너뜨리지만, 커트라인은 표본에서 덜어내기만 한다.

  **만점 지점은 60일에 그대로 둔다.** `EXHAUSTION_FULL_SPAN`을 45 → 30으로 같이
  줄인 것은 커트라인이 올라간 만큼 보정한 것일 뿐이다(30+30=60). 이렇게 안 하면
  만점 지점이 75일로 밀려 **한 번에 두 가지를 바꾸는 꼴**이 된다.

  **미리 정한 합격 기준** (고친 뒤에 말을 바꾸지 않으려고 먼저 적는다):
    (1) 점수 구간별 중간값이 **단조 증가**할 것 (40~49 < 50~59 < 60~69 < 70점+)
    (2) 순위 1~5위가 11위 이하보다 **나쁘지 않을 것**
  기준선은 v4 원본(run 34809895549, 694건):
    점수 3.46 / 11.06 / 20.77 / **-3.09**, 순위 0.00 / 2.19 / **12.66**
  하나라도 안 되면 실패로 보고 되돌린다.

  ⚠️ 참고: v4에서 "70점 이상이 나쁘다"고 읽었지만 그 구간은 **최다종목 11.5%**로
  쏠려 있다(87건/47종목). 순위 1~5위도 평균 54.71%·중간값 0.00%·-30%이하 20.3%로,
  "나쁘다"기보다 **변동성이 극단적으로 크다**가 정확한 표현이다. 지금 점수는
  "좋은 종목"이 아니라 **"극단적인 종목"**을 재고 있다 — v5 이후 단계가 풀 문제다.
"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

# ── 튜닝 상수 (여기서 직접 조정) ────────────────────────────────────
TOP_N = 20
MIN_SCORE = 0.40

# 가격 범위
MIN_PRICE = 0.50
MAX_PRICE = 50.0

# 하드 필터 기준값
MIN_DRAWDOWN = 0.55          # 52주 최고가 대비 55% 이상 하락
# 저점 갱신 중단 기간 커트라인. **15 → 30으로 올렸다 (v5, 2026-09-14).**
# 15~29일 구간만 성적이 마이너스였다(중간값 -3.96%·승률 44.0%, 50건, 최다종목 6.0%) —
# 나머지 구간은 전부 +10% 이상이다. 가산점이 아니라 **커트라인**으로 올린 것이 핵심이다
# (docstring v5 참고).
MIN_DAYS_SINCE_LOW = 30
MIN_VOL_RATIO = 0.70         # 최근 20일 거래량 / 직전 40일 거래량 ≥ 0.70 (유지)
MIN_DOLLAR_VOL = 300_000     # 일평균 거래대금 $30만 이상 (최소 유동성)

# 복합 점수 가중치 (합산 = 1.0)
WEIGHT_DRAWDOWN = 0.3
WEIGHT_EXHAUSTION = 0.4
WEIGHT_VOLUME = 0.3

# 점수 만점 지점. **당겨봤다가 되돌린 값이다** — 근거는 모듈 docstring v4 ①.
# 65%/50일로 당기면 대부분이 만점을 받아 점수가 줄을 못 세운다(70점 이상이 표본의
# 65%가 됐다). 넓게 두는 것이 변별력을 지킨다. 값은 v3와 같고, 이름만 붙여
# "어디가 만점인지"가 코드에서 바로 보이게 했다.
DRAWDOWN_FULL_SPAN = 0.35    # 하한(55%) + 이만큼 = 90%에서 하락률 만점
EXHAUSTION_FULL_SPAN = 30.0  # 하한(30일) + 이만큼 = 60일에서 소진일수 만점 (v5에서 45.0→30.0)

# 보너스 점수 (최종 점수는 1.0으로 상한)
VCP_ATR_SHORT = 10           # 단기 ATR 기간
VCP_ATR_LONG = 50            # 장기 ATR 기간
VCP_ATR_THRESHOLD = 0.6      # ATR_SHORT / ATR_LONG ≤ 이 값 → 변동성 수축
VCP_BONUS = 0.10

MA_SHORT1 = 5
MA_SHORT2 = 10
MA_SHORT3 = 20
MA_ALIGN_BONUS = 0.10        # 현재가 > SMA5 > SMA10 > SMA20

# 저점 높이기는 **점수에 넣지 않고 기록만 한다** (2026-09-14 시도했다가 되돌림).
# 관측으로는 우위가 뚜렷했지만 가산점을 주니 선발 구성이 바뀌어 우위가 사라졌다.
HIGHER_LOW_SPAN = 20         # 비교 구간(거래일). supportSignals.ts와 같은 길이

VOL_TRIGGER_MULTIPLIER = 2.0  # 오늘 거래량이 90일 평균 2배 이상 → 거래량 트리거
DOJI_BODY_RATIO = 0.1         # 몸통 ÷ (고가-저가) 이 값 이하면 십자형(도지)로 본다


# ── 기술 지표 (NumPy 벡터 연산) ─────────────────────────────────────

def _true_range(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    prev_close = np.empty_like(close)
    prev_close[0] = close[0]
    prev_close[1:] = close[:-1]
    return np.maximum(
        high - low,
        np.maximum(np.abs(high - prev_close), np.abs(low - prev_close)),
    )


def _vcp_bonus_val(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> float:
    if len(close) < VCP_ATR_LONG + 1:
        return 0.0
    tr = _true_range(high, low, close)
    atr_short = tr[-VCP_ATR_SHORT:].mean()
    atr_long = tr[-VCP_ATR_LONG:].mean()
    return VCP_BONUS if (atr_long > 0 and atr_short / atr_long <= VCP_ATR_THRESHOLD) else 0.0


def _ma_align_bonus_val(close: np.ndarray) -> float:
    """단기 이평 정배열이면 +0.10.

    **2026-09-14에 빼봤다가 되돌렸다.** 관측만 보면 정배열 종목이 오히려 나빴지만
    (중간값 5.86%·승률 56.5% vs 10.84%·59.3%), 실제로 빼고 재검증하니 전체가
    나아지지 않았고 다른 조건의 관측값까지 뒤집혔다. 자세한 수치는 docstring v4 ③.
    """
    if len(close) < MA_SHORT3:
        return 0.0
    sma5 = close[-MA_SHORT1:].mean()
    sma10 = close[-MA_SHORT2:].mean()
    sma20 = close[-MA_SHORT3:].mean()
    return MA_ALIGN_BONUS if (close[-1] > sma5 > sma10 > sma20) else 0.0


def _is_higher_low(low: np.ndarray) -> bool:
    """최근 20봉 저점이 그 직전 20봉 저점보다 높은가. **점수에는 안 들어간다.**

    저점을 안 깨는 기간(`days_since_low`)만으로는 바닥을 기는 종목과 바닥을
    들어올리는 종목이 구분되지 않는다. 『매매의 기술』은 역헤드앤숄더를 "저점을
    높이며 거래량 증가"로 설명한다.

    **관측으로는 가장 뚜렷했는데 가산점으로는 실패했다** (2026-09-14):
    관측 단계에서는 60거래일 중간값 11.72%·승률 59.9% vs 8.62%·57.8%로 깨끗하게
    갈렸다. 그런데 +0.10을 주고 재검증하니 이 조건 종목이 272건 → 398건으로 늘면서
    중간값 8.36%·승률 56.8%로 떨어지고 승률은 오히려 역전됐다(안 높임 58.6%).
    가산점이 **선발 구성 자체를 바꿔서** 다른 조건이 약한 종목까지 상위에 올려보낸
    것으로 보인다.

    그래서 점수에서 빼고 `recommendation_history`에 기록만 남긴다 — 관측은 계속
    쌓되 선발에는 개입하지 않는다. 나중에 가산점이 아닌 **하드 필터**로 시험해 볼
    여지가 남아 있다.

    ⚠️ 교훈: "조건 A인 종목의 성적이 좋았다"는 "A에 가산점을 주면 전체가 좋아진다"를
    뜻하지 않는다. 가산점은 표본 자체를 바꾼다.
    """
    span = HIGHER_LOW_SPAN
    if len(low) < 2 * span:
        return False
    return bool(low[-span:].min() > low[-2 * span : -span].min())


def _is_volume_trigger_today(
    open_: np.ndarray,
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    vol: np.ndarray,
) -> bool:
    """오늘 터진 대량거래가 '매수' 쪽 신호인지 판정.

    거래량만으로는 방향을 알 수 없다 — 『매매의 기술』(2장 거래량):
    **"거래량은 타이밍만 제공한다. 방향은 봉의 모양이 결정한다."**
    같은 책의 매수 제3원칙(20일선 아래 급락 중)은 "거래량 증가 + **양봉 또는
    십자형**이 나올 때" 매수하라고 하고, 거래량 8원칙 2번은 "거래량 증가 +
    장대음봉 = **매물**"이라고 정반대로 못 박는다.

    예전에는 거래량 2배 조건만 보고 True를 돌려줬다. 그래서 악재로 투매가 터진 날
    (대량거래 장대음봉)도 반등 신호와 똑같이 ⚡ 배지가 붙어, 화면에서 정반대 신호가
    구분되지 않았다. 지금은 대량거래 **+ (양봉 또는 십자형)** 일 때만 True다.
    """
    if len(vol) < 2:
        return False
    n = min(90, len(vol) - 1)
    baseline = vol[-n - 1 : -1].mean()
    if not (baseline > 0 and vol[-1] >= baseline * VOL_TRIGGER_MULTIPLIER):
        return False

    o, h, l, c = float(open_[-1]), float(high[-1]), float(low[-1]), float(close[-1])
    if c > o:
        return True  # 양봉

    # 십자형(도지) = 대량거래인데 몸통이 거의 없다 → 황소와 곰이 치열하게 싸워
    # 우열이 안 갈린 상태. 책은 "큰 폭 하락 후 십자형"을 매수 신호로 본다.
    # 고가=저가(가격이 하루 내내 안 움직인 봉)는 싸움 자체가 없었다는 뜻이라 제외한다.
    bar_range = h - l
    if bar_range <= 0:
        return False
    return bool(abs(c - o) / bar_range <= DOJI_BODY_RATIO)


# ── 핵심 스코어링 ───────────────────────────────────────────────────

def _score_candidate(
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    vol: np.ndarray,
    high_52w: float,
) -> tuple[bool, dict]:
    """룰 기반 복합 스코어. 하드 필터 미충족 시 (False, {}) 반환."""
    if len(close) < 30:
        return False, {}

    current = float(close[-1])

    # 가격 범위
    if not (MIN_PRICE <= current <= MAX_PRICE):
        return False, {}

    # KIS 1년치 이력에서 계산된 52주 최고가 기준 하락률
    ref_high = high_52w if high_52w > 0 else float(high.max())
    drawdown = (ref_high - current) / ref_high if ref_high > 0 else 0.0
    if drawdown < MIN_DRAWDOWN:
        return False, {}

    # 저점 갱신 중단일 수 — reversed 배열에서 최소값 첫 인덱스 = 가장 최근 저점
    low_val = float(close.min())
    rev_indices = np.where(close[::-1] == low_val)[0]
    if len(rev_indices) == 0:
        return False, {}
    days_since_low = int(rev_indices[0])
    if days_since_low < MIN_DAYS_SINCE_LOW:
        return False, {}

    # 거래량 유지 비율
    n = len(vol)
    if n >= 61:
        recent_vol = vol[-20:].mean()
        baseline_vol = vol[-60:-20].mean()
    elif n >= 41:
        recent_vol = vol[-20:].mean()
        baseline_vol = vol[-40:-20].mean()
    else:
        half = max(n // 2, 1)
        recent_vol = vol[-half:].mean()
        baseline_vol = vol[:-half].mean() if n - half > 0 else vol[-1]
    vol_ratio = float(recent_vol / baseline_vol) if baseline_vol > 0 else 1.0
    if vol_ratio < MIN_VOL_RATIO:
        return False, {}

    # 복합 스코어
    drawdown_score = min(1.0, (drawdown - MIN_DRAWDOWN) / DRAWDOWN_FULL_SPAN)
    exhaustion_score = min(1.0, (days_since_low - MIN_DAYS_SINCE_LOW) / EXHAUSTION_FULL_SPAN)
    vol_score = min(1.0, max(0.0, (vol_ratio - 1.0) / 2.0))

    base = (
        WEIGHT_DRAWDOWN * drawdown_score
        + WEIGHT_EXHAUSTION * exhaustion_score
        + WEIGHT_VOLUME * vol_score
    )

    # 보너스는 VCP와 이평 정배열 둘뿐이다. 저점 높이기는 가산점으로 주면 선발
    # 구성이 바뀌어 역효과였으므로(docstring v4 ②) 채점에 넣지 않고 기록만 한다.
    vcp_b = _vcp_bonus_val(high, low, close)
    ma_b = _ma_align_bonus_val(close)
    score = min(1.0, base + vcp_b + ma_b)

    return True, {
        "score": score,
        "drawdown": drawdown,
        "days_since_low": days_since_low,
        "vol_ratio": vol_ratio,
        "vcp": vcp_b > 0,
        "ma_align": ma_b > 0,
        # 채점에 안 쓰이지만 남긴다 — 나중에 하드 필터로 다시 시험할 근거가 된다.
        "higher_low": _is_higher_low(low),
    }


# ── 메인 ─────────────────────────────────────────────────────────

def compute_pattern_matches(
    all_histories: dict[str, pd.DataFrame],
    universe: pd.DataFrame,
) -> list[dict[str, Any]]:
    """Gold Standard 바닥 특성에 부합하는 종목 상위 TOP_N 계산.

    Parameters
    ----------
    all_histories : 파이프라인이 수집한 전 종목 가격 이력 (ticker → DataFrame)
    universe      : US universe DataFrame (ticker, name, sector 컬럼 포함)
    """
    # universe lookup — iterrows() 없이 벡터 변환
    uni = universe[["ticker", "name", "sector"]].copy() if "name" in universe.columns else universe[["ticker", "sector"]].copy()
    if "name" not in uni.columns:
        uni["name"] = ""
    universe_map: dict[str, dict] = {
        t: {"name": (n or ""), "sector": (s if s and str(s) != "nan" else None)}
        for t, n, s in zip(uni["ticker"], uni["name"], uni["sector"])
    }

    results: list[dict[str, Any]] = []
    total = len(all_histories)
    passed = 0

    for ticker, hist in all_histories.items():
        if hist.empty:
            continue

        # DataFrame → NumPy 배열 (이후 모든 계산 벡터화)
        close = hist["Close"].to_numpy(dtype=float)
        vol = hist["Volume"].to_numpy(dtype=float)
        high = hist["High"].to_numpy(dtype=float) if "High" in hist.columns else close.copy()
        low = hist["Low"].to_numpy(dtype=float) if "Low" in hist.columns else close.copy()
        # 시가는 거래량 트리거의 봉 방향(양봉/십자형) 판정에만 쓴다.
        # **시가가 없는 소스를 종가로 메우면 조용히 틀린다** — 그러면 몸통이 0이라
        # 모든 대량거래일이 십자형(=매수 신호)으로 잡혀, 고치려던 "방향을 안 본다"는
        # 문제가 그대로 남는다. prices_us._rows_to_df가 KIS 응답에 시가 칸이 없으면
        # 종가로 채우므로(`_first(r, _OPEN_KEYS) or c`) 실제로 생길 수 있는 상황이다.
        # 전 구간 시가=종가면 진짜 봉이 아니라 메운 값이므로 트리거를 끈다.
        open_ = hist["Open"].to_numpy(dtype=float) if "Open" in hist.columns else close.copy()
        has_open = "Open" in hist.columns and not np.array_equal(open_, close)

        # 최소 유동성 (벡터 연산)
        if (close * vol).mean() < MIN_DOLLAR_VOL:
            continue

        # KIS 1년치 이력(lookback_days=380)에서 52주 최고가 직접 계산
        high_52w = float(high.max())
        qualifies, stats = _score_candidate(high, low, close, vol, high_52w)
        if not qualifies or stats["score"] < MIN_SCORE:
            continue

        # matched_bottom 설명 문자열 생성
        drawdown_pct = stats["drawdown"] * 100
        days = stats["days_since_low"]
        vr = stats["vol_ratio"]
        vcp_tag = "VCP ✓" if stats["vcp"] else "VCP ✗"
        ma_tag = "이평 ✓" if stats["ma_align"] else "이평 ✗"

        matched_bottom = (
            f"하락률 {drawdown_pct:.0f}% · 저점 유지 {days}일 · "
            f"거래량 {vr:.2f}배 · {vcp_tag} · {ma_tag}"
        )

        meta = universe_map.get(ticker, {})
        results.append(
            {
                "ticker": ticker,
                "name": meta.get("name") or ticker,
                "sector": meta.get("sector"),
                "similarity": round(stats["score"], 4),
                "matched_standard": "Gold Standard 바닥 특성",
                "matched_standard_ticker": None,
                "matched_bottom": matched_bottom,
                "volume_triggered": (
                    has_open and _is_volume_trigger_today(open_, high, low, close, vol)
                ),
                "close": float(close[-1]),
                # 추천 성적을 나중에 "어떤 특성의 후보가 잘 맞았나"로 쪼개려면
                # 추천 시점의 원본 수치가 남아 있어야 한다. matched_bottom은 사람이
                # 읽는 문자열이라 집계에 못 쓴다 → db.save_recommendation_history가
                # 이 값들을 recommendation_history에 같이 저장한다.
                "drawdown_pct": round(stats["drawdown"] * 100, 2),
                "days_since_low": stats["days_since_low"],
                "vol_ratio": round(stats["vol_ratio"], 4),
                "vcp": stats["vcp"],
                "ma_align": stats["ma_align"],
                "higher_low": stats["higher_low"],
            }
        )
        passed += 1

    results.sort(key=lambda x: x["similarity"], reverse=True)
    top = results[:TOP_N]
    print(
        f"  [pattern_discovery] 완료: {total}개 스캔 → {passed}개 조건 충족 → "
        f"상위 {len(top)}개 저장 (MIN_SCORE={MIN_SCORE:.0%})",
        flush=True,
    )
    return top
