"""저점 매집 후보 — **특성별** 성적 백테스트 (개선안 12~15번 판정용)

기존 `backtest_both.py`의 골드스탠다드 백테스트와 목적이 다르다. 그쪽은 "이 전략을
따라가면 돈을 버나"(진입 후 +300%/-50%/2년)를 묻고, 이쪽은 **"점수를 이루는 조건 중
어느 것이 실제로 성과와 연결되나"**를 묻는다. 그래서 세 가지가 다르다:

| | backtest_both.py | 이 스크립트 |
|---|---|---|
| 점수 임계값 | 0.90 / 0.95 / 1.00 | **MIN_SCORE(0.40) + 날짜별 상위 TOP_N(20)** — 화면에 실제로 뜨는 조건 |
| 성과 측정 | +300% 익절 / -50% 손절 / 2년 | **20·60·120·250거래일 보유 수익률** (프론트 성적 화면과 같은 잣대) |
| 기록 | 점수만 | 채점에 쓰인 **원본 특성 + 아직 안 쓰는 후보 지표**까지 |

왜 필요한가 — 『매매의 기술』과 『친절한 주가차트책』이 소진일수를 놓고 정면으로
충돌한다(전자: "저점에서 오래 기회를 주면 추가 하락", 후자: "바닥권 장기 횡보 후
밀집하면 힘있게 상승"). 책으로는 못 정하므로 과거 데이터로 판정한다.

**판정 대상**
  12번 소진일수(`days_since_low`)    — 구간별 성적이 갈리는가
  13번 하락 속도(`decline_days`)      — 급락한 종목이 완만히 내린 종목보다 나은가
  14번 50% 룰(`bull_50_rule`)         — 전일 음봉의 50% 회복이 유효한 신호인가
  15번 저점 높이기(`higher_low`)      — 관측만 한다. 가산점으로 줬다가 되돌렸다
                                        (우위가 사라졌다 — `_is_higher_low` 주석 참고)
  11번 거래량 배지(`volume_badge`)    — 봉 방향 조건을 붙인 것이 실제로 맞았는가 (사후 검증)

13~15번 지표는 **점수에 넣지 않고 측정만 한다.** 먼저 성과와 연결되는지 보고,
그 다음에 넣을지 정한다.

**한계 (결과를 읽을 때 반드시 감안할 것)**
  - **생존 편향**: 유니버스가 '오늘 시점'의 목록이라 그 사이 상장폐지된 종목이 빠져 있다.
    바닥 종목을 고르는 전략이라 이 편향이 특히 크게 작용한다 — 실제 성적은 여기 나온
    숫자보다 나쁘다. 구간끼리 **비교**하는 용도로만 쓸 것(절대 수치를 믿지 말 것).
  - 같은 종목이 쿨다운(30일) 간격으로 여러 번 들어가므로 표본이 서로 독립이 아니다.
  - 기간이 3년(`YEARS_BACK`)뿐이라 장세 한두 국면만 담긴다.

실행: GitHub Actions `.github/workflows/backtest_pattern_features.yml`
      (작업 컨테이너는 yfinance가 막혀 있다 — `CONNECT tunnel failed, 403`)
"""
from __future__ import annotations

import hashlib
import pickle
import sys
from contextlib import contextmanager
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from pipeline.src import pattern_discovery  # noqa: E402
from pipeline.src.pattern_discovery import (  # noqa: E402
    MIN_DOLLAR_VOL,
    MIN_SCORE,
    TOP_N,
    _is_volume_trigger_today,
    _score_candidate,
)

# ── 설정 ──────────────────────────────────────────────────────────────
YEARS_BACK = 3
LOOKBACK_ROWS = 260      # 채점 창(거래일 ≈ 1년). 프로덕션 lookback_days=380과 대응
MIN_START_ROWS = 120     # 이만큼 봉이 쌓인 뒤부터 스캔 (채점이 앞쪽에서 의미 없어짐)
COOLDOWN_DAYS = 30       # 같은 종목 재진입 최소 간격(캘린더일)

# 보유 기간(거래일). 60은 프론트 patternScorecard.PATTERN_HOLD_BARS와 같은 값 —
# 백테스트와 화면이 다른 잣대를 쓰면 두 숫자를 나란히 못 읽는다. 나머지는
# "바닥 반등에 3개월이 너무 짧은가"를 같이 보려고 넣었다.
HORIZONS = [20, 60, 120, 250]
PRIMARY_HORIZON = 60

BIG_MOVE_PCT = 30        # 프론트와 같은 경계
MIN_SEGMENT_SAMPLE = 20  # 구간별 표에서 이보다 적으면 빼다 (백테스트는 표본이 많아 프론트보다 엄격하게)

# 하락률 스윕: 하한을 여기까지 낮춰 "55%가 맞는 지점인가"를 본다.
# 지금 표본은 55% 이상만 들어 있어 그 아래가 더 좋았을 가능성을 아예 못 본다.
SWEEP_MIN_DRAWDOWN = 0.25

OUT_DIR = Path(__file__).parent
CACHE_DIR = OUT_DIR / "_cache"
TRADES_CSV = OUT_DIR / "backtest_pattern_features_trades.csv"
SUMMARY_CSV = OUT_DIR / "backtest_pattern_features_summary.csv"
SWEEP_TRADES_CSV = OUT_DIR / "backtest_drawdown_sweep_trades.csv"
SWEEP_SUMMARY_CSV = OUT_DIR / "backtest_drawdown_sweep_summary.csv"


# ── 유니버스 · 가격 데이터 ────────────────────────────────────────────

def get_universe() -> list[str]:
    """프로덕션과 같은 US 유니버스(S&P1500 + NASDAQ100 + Russell3000).

    backtest_pullback.get_universe_tickers()를 쓰지 않는 이유: 그쪽은 위키백과와
    VTHR 보유종목 파일을 읽는데 둘 다 2026-09-09에 막혔다(CLAUDE.md 참고).
    지금 실제로 값이 오는 경로는 universe_us의 네이버 소스뿐이다.
    """
    from pipeline.src.universe_us import get_us_universe

    print("유니버스 수집 중 (프로덕션과 동일 경로)...")
    df = get_us_universe()
    tickers = sorted({str(t) for t in df["ticker"].tolist() if t})
    print(f"  총 유니버스: {len(tickers)}개")
    return tickers


_FIELDS = ["Open", "High", "Low", "Close", "Volume"]


def _cache_path(tickers: list[str], end: pd.Timestamp) -> Path:
    key = hashlib.md5("|".join(sorted(tickers)).encode()).hexdigest()[:8]
    return CACHE_DIR / f"ohlcv_open_{YEARS_BACK}y_{end.date()}_{len(tickers)}_{key}.pkl"


def download_ohlcv(tickers: list[str]) -> dict[str, pd.DataFrame]:
    """3년치 OHLCV. **backtest_both와 달리 Open까지 받는다** — 50% 룰과 거래량
    배지(양봉/십자형)가 시가 없이는 판정이 안 되기 때문에 캐시도 따로 쓴다.
    """
    end = pd.Timestamp.today().normalize()
    start = end - pd.DateOffset(years=YEARS_BACK)

    cache = _cache_path(tickers, end)
    if cache.exists():
        print(f"\n캐시된 OHLCV 사용: {cache.name}")
        with open(cache, "rb") as fh:
            return pickle.load(fh)

    print(f"\nOHLCV 다운로드 ({start.date()} ~ {end.date()}) — 10~20분 예상")
    batch_size = 100
    parts: dict[str, list[pd.DataFrame]] = {f: [] for f in _FIELDS}
    n_batches = (len(tickers) + batch_size - 1) // batch_size

    for i in range(0, len(tickers), batch_size):
        batch = tickers[i : i + batch_size]
        sys.stdout.write(f"\r  배치 {i // batch_size + 1}/{n_batches} ...")
        sys.stdout.flush()
        try:
            raw = yf.download(batch, start=start, end=end, auto_adjust=True, progress=False)
            if raw.empty:
                continue
            for f in _FIELDS:
                if isinstance(raw.columns, pd.MultiIndex):
                    if f in raw.columns.get_level_values(0):
                        parts[f].append(raw[f])
                elif f in raw.columns:
                    parts[f].append(raw[[f]].rename(columns={f: batch[0]}))
        except Exception as exc:  # noqa: BLE001
            print(f"\n  배치 {i // batch_size + 1} 오류: {exc}")

    print()
    if not parts["Close"]:
        return {}

    field_df = {}
    for f in _FIELDS:
        if not parts[f]:
            continue
        df = pd.concat(parts[f], axis=1)
        field_df[f] = df.loc[:, ~df.columns.duplicated()]

    # 채점 창 + 가장 긴 보유 기간을 모두 채울 수 있는 종목만 남긴다.
    min_rows = MIN_START_ROWS + max(HORIZONS)
    ohlcv: dict[str, pd.DataFrame] = {}
    for t in field_df["Close"].columns:
        c = field_df["Close"][t].dropna()
        if len(c) < min_rows:
            continue
        idx = c.index
        cols = {"Close": c}
        for f in ("Open", "High", "Low"):
            cols[f] = field_df[f][t].reindex(idx).ffill() if f in field_df and t in field_df[f].columns else c
        cols["Volume"] = (
            field_df["Volume"][t].reindex(idx).fillna(0)
            if "Volume" in field_df and t in field_df["Volume"].columns
            else pd.Series(0.0, index=idx)
        )
        ohlcv[t] = pd.DataFrame(cols)

    print(f"  유효 종목: {len(ohlcv)}개")
    CACHE_DIR.mkdir(exist_ok=True)
    with open(cache, "wb") as fh:
        pickle.dump(ohlcv, fh)
    print(f"  캐시 저장: {cache.name}")
    return ohlcv


def download_spy() -> pd.Series | None:
    """벤치마크. 같은 진입일·같은 보유 기간의 SPY 수익률을 빼서 초과수익을 낸다.

    프론트 성적 화면에는 이 기준선이 없다(지수 일봉을 DB에 안 쌓아서). 백테스트에는
    있으므로 여기서라도 "시장이 그냥 오른 것"과 구분한다.
    """
    end = pd.Timestamp.today().normalize()
    start = end - pd.DateOffset(years=YEARS_BACK)
    try:
        raw = yf.download("SPY", start=start, end=end, auto_adjust=True, progress=False)
        close = raw["Close"]
        if isinstance(close, pd.DataFrame):
            close = close.iloc[:, 0]
        return close.dropna()
    except Exception as exc:  # noqa: BLE001
        print(f"  SPY 다운로드 실패: {exc} — 초과수익 없이 진행")
        return None


# ── 아직 점수에 안 들어간 후보 지표 ───────────────────────────────────

def _decline_days(w_high: np.ndarray, w_close: np.ndarray) -> int | None:
    """고점에서 저점까지 걸린 거래일 수 (13번).

    『매매의 기술』: "급락한 주식은 하락 시 매수자가 적어 반등 시 매물이 적다 → 좋음.
    완만하게 하락한 주식은 매수자가 많이 물려 있어 반등 시 매물이 많다 → 나쁨."

    저점은 `_score_candidate`가 쓰는 것과 같은 종가 최저값이되, 여기서는 **처음**
    찍은 위치를 쓴다(저쪽은 마지막 위치로 경과일을 센다 — 목적이 다르다).
    """
    peak_i = int(np.argmax(w_high))
    trough_i = int(np.argmin(w_close))
    return trough_i - peak_i if trough_i > peak_i else None


def _bull_50_rule(w_open: np.ndarray, w_close: np.ndarray) -> bool | None:
    """황소의 50% 룰 — 전일 음봉의 50%를 넘겨 마감했는가 (14번).

    전일이 음봉이 아니면 이 룰의 판정 대상이 아니므로 None(집계에서 빠진다).
    """
    if len(w_close) < 2:
        return None
    prev_open, prev_close = float(w_open[-2]), float(w_close[-2])
    if prev_close >= prev_open:
        return None
    return bool(w_close[-1] > (prev_open + prev_close) / 2)


# ── 워크포워드 스캔 ───────────────────────────────────────────────────

def scan(ohlcv: dict[str, pd.DataFrame], min_score: float | None = MIN_SCORE) -> pd.DataFrame:
    """모든 거래일 × 모든 종목을 채점해 자격 후보를 모은다 (lookahead 없음).

    `min_score=None`이면 점수 하한을 걸지 않는다 — 하락률 스윕에서 쓴다. 점수 공식의
    `drawdown_score`가 55%에 고정돼 있어서, 하한만 낮추고 점수로 또 거르면 얕은 종목이
    전부 탈락해 스윕이 아무것도 못 본다.
    """
    rows: list[dict] = []
    total = len(ohlcv)

    for n_done, (ticker, df) in enumerate(ohlcv.items()):
        if n_done % 200 == 0:
            sys.stdout.write(f"\r  스캔 {n_done}/{total} — 후보 {len(rows)}건 ")
            sys.stdout.flush()

        index = df.index
        open_ = df["Open"].to_numpy(dtype=float)
        high = df["High"].to_numpy(dtype=float)
        low = df["Low"].to_numpy(dtype=float)
        close = df["Close"].to_numpy(dtype=float)
        vol = df["Volume"].to_numpy(dtype=float)
        n = len(close)

        # 가장 긴 보유 기간을 못 채우는 날은 애초에 스캔하지 않는다 — 60일 판정만
        # 되고 250일은 비는 행이 섞이면 지평선마다 표본이 달라져 비교가 어려워진다.
        for i in range(MIN_START_ROWS, n - max(HORIZONS)):
            lo = max(0, i - LOOKBACK_ROWS + 1)
            sl = slice(lo, i + 1)
            w_open, w_high, w_low = open_[sl], high[sl], low[sl]
            w_close, w_vol = close[sl], vol[sl]

            # 유동성 필터 — compute_pattern_matches와 같은 순서로 먼저 건다
            if (w_close * w_vol).mean() < MIN_DOLLAR_VOL:
                continue

            ok, stats = _score_candidate(w_high, w_low, w_close, w_vol, float(w_high.max()))
            if not ok or (min_score is not None and stats["score"] < min_score):
                continue

            entry = float(close[i])
            seg = slice(i + 1, i + 1 + PRIMARY_HORIZON)
            row = {
                "ticker": ticker,
                "date": index[i].date(),
                "bar_i": i,
                "entry_price": round(entry, 4),
                # 채점에 실제로 쓰인 값
                "score": round(float(stats["score"]), 4),
                "drawdown_pct": round(stats["drawdown"] * 100, 2),
                "days_since_low": int(stats["days_since_low"]),
                "vol_ratio": round(float(stats["vol_ratio"]), 4),
                "vcp": bool(stats["vcp"]),
                "ma_align": bool(stats["ma_align"]),
                # 점수에는 안 들어가지만 production이 기록해 두는 관측 지표.
                # 여기서 따로 계산하지 않고 production이 낸 값을 그대로 쓴다 —
                # 같은 값을 두 곳에서 계산하면 조용히 어긋난다(반복해서 당한 사고다).
                "higher_low": bool(stats["higher_low"]),
                # 아직 점수에 안 들어간 후보 지표
                "volume_badge": _is_volume_trigger_today(w_open, w_high, w_low, w_close, w_vol),
                "decline_days": _decline_days(w_high, w_close),
                "bull_50_rule": _bull_50_rule(w_open, w_close),
                # 성과
                "max_gain_pct": round((float(high[seg].max()) / entry - 1) * 100, 2),
                "max_drop_pct": round((float(low[seg].min()) / entry - 1) * 100, 2),
            }
            for h in HORIZONS:
                row[f"ret_{h}d_pct"] = round((float(close[i + h]) / entry - 1) * 100, 2)
            rows.append(row)

    print(f"\r  스캔 완료 — 자격 후보 {len(rows)}건" + " " * 20)
    return pd.DataFrame(rows)


def select_screen_candidates(df: pd.DataFrame) -> pd.DataFrame:
    """화면에 실제로 떴을 후보만 남긴다: 날짜별 점수 상위 TOP_N + 종목당 쿨다운.

    이 단계가 없으면 "40점을 넘긴 모든 종목"의 성적이 되는데, 사용자가 보는 건
    매일 상위 20개뿐이라 다른 모집단이 된다.
    """
    if df.empty:
        return df

    ranked = (
        df.sort_values(["date", "score"], ascending=[True, False])
        .groupby("date", sort=True)
        .head(TOP_N)
        .copy()
    )
    ranked["rank"] = ranked.groupby("date")["score"].rank(method="first", ascending=False).astype(int)

    out = apply_cooldown(ranked)
    print(f"  화면 기준(상위 {TOP_N} + 쿨다운 {COOLDOWN_DAYS}일) 적용 → {len(out)}건")
    return out


def apply_cooldown(df: pd.DataFrame) -> pd.DataFrame:
    """같은 종목의 재진입 간격을 COOLDOWN_DAYS로 제한한다.

    같은 종목이 바닥 구간 내내 매일 뽑히므로 솎아야 한다. 다만 아예 첫 등장만
    남기면 days_since_low가 항상 하한(15일) 근처라 12번을 판정할 변화가 사라진다 —
    30일 간격이면 같은 종목이 15일·45일·75일…로 다시 들어와 구간이 채워진다.
    """
    kept: list[int] = []
    last_seen: dict[str, pd.Timestamp] = {}
    for idx, ticker, date in zip(df.index, df["ticker"], df["date"]):
        ts = pd.Timestamp(date)
        prev = last_seen.get(ticker)
        if prev is not None and (ts - prev).days < COOLDOWN_DAYS:
            continue
        last_seen[ticker] = ts
        kept.append(idx)
    return df.loc[kept]


def add_benchmark(df: pd.DataFrame, spy: pd.Series | None) -> pd.DataFrame:
    """같은 진입일·같은 기간의 SPY 수익률과 초과수익."""
    if spy is None or df.empty:
        return df
    spy_idx = spy.index
    spy_val = spy.to_numpy(dtype=float)

    for h in HORIZONS:
        bench, excess = [], []
        for date, ret in zip(df["date"], df[f"ret_{h}d_pct"]):
            pos = int(np.searchsorted(spy_idx.values, np.datetime64(pd.Timestamp(date)), side="left"))
            if pos >= len(spy_val) or pos + h >= len(spy_val):
                bench.append(np.nan)
                excess.append(np.nan)
                continue
            b = (spy_val[pos + h] / spy_val[pos] - 1) * 100
            bench.append(round(b, 2))
            excess.append(round(ret - b, 2))
        df[f"bench_{h}d_pct"] = bench
        df[f"excess_{h}d_pct"] = excess
    return df


# ── 집계 ──────────────────────────────────────────────────────────────

def _card(sub: pd.DataFrame, horizon: int) -> dict:
    """프론트 patternScorecard.summarizePattern과 같은 지표를 낸다 — 백테스트와
    화면이 다른 말을 하면 어느 쪽을 믿을지 알 수 없다.

    거기에 **쏠림 진단**을 더한다. 구간 하나가 소수 종목이나 한 시기에 몰려 있으면
    그 구간의 평균은 "그 조건이 좋다"가 아니라 "그 종목/그 시기가 좋았다"는 뜻인데,
    n만 봐서는 구분이 안 된다. 실제로 순위 구간에서 그 의심이 생겨 추가했다.
    """
    rets = sub[f"ret_{horizon}d_pct"].dropna()
    if rets.empty:
        return {}
    excess_col = f"excess_{horizon}d_pct"
    excess = sub[excess_col].dropna() if excess_col in sub.columns else pd.Series(dtype=float)

    valid = sub.loc[rets.index]
    counts = valid["ticker"].value_counts()
    dates = pd.to_datetime(valid["date"])

    return {
        "n": len(rets),
        "종목수": int(counts.size),
        "최다종목%": round(counts.iloc[0] / len(rets) * 100, 1),
        "평균%": round(rets.mean(), 2),
        "중간값%": round(rets.median(), 2),
        "승률%": round((rets > 0).mean() * 100, 1),
        f"+{BIG_MOVE_PCT}%이상": round((rets >= BIG_MOVE_PCT).mean() * 100, 1),
        f"-{BIG_MOVE_PCT}%이하": round((rets <= -BIG_MOVE_PCT).mean() * 100, 1),
        "SPY대비%": round(excess.mean(), 2) if not excess.empty else None,
        "중앙진입월": dates.median().strftime("%Y-%m"),
    }


def _bucket_vol_ratio(v) -> str | None:
    """거래량비 구간. **가중치가 0.3인데 지금까지 구간 표가 없었다** (v5에서 추가).

    점수는 `(vol_ratio-1)/2`로 3.0배에서 만점인데, 이 값이 성과와 어떤 모양으로
    연결되는지 한 번도 측정한 적이 없다. 다음 단계에서 가중치를 손대려면 근거가 필요하다.
    """
    if v is None or pd.isna(v):
        return None
    v = float(v)
    if v < 1.0:
        return "1. 1.0배 미만"
    if v < 1.5:
        return "2. 1.0~1.5배"
    if v < 2.0:
        return "3. 1.5~2.0배"
    return "4. 2.0배 이상"


def _bucket_days_since_low(v) -> str | None:
    if pd.isna(v):
        return None
    v = int(v)
    # 커트라인이 30일로 올라가 15~29일 칸은 더 이상 나오지 않는다(v5).
    # 대신 **60일 이상을 쪼갠다** — 예전에는 694건 중 548건(79%)이 이 한 칸에 몰려
    # 있어서 "30일만 넘으면 평평한가"를 확인할 수가 없었다. 선발을 바꾸지 않는
    # 측정 해상도 변경이라 알고리즘 변경과 섞이지 않는다.
    if v < 45:
        return "1. 30~44일"
    if v < 60:
        return "2. 45~59일"
    if v < 90:
        return "3. 60~89일"
    return "4. 90일 이상"


def _bucket_drawdown(v) -> str | None:
    if pd.isna(v):
        return None
    if v < 65:
        return "1. 55~65%"
    if v < 75:
        return "2. 65~75%"
    return "3. 75% 이상"


def _bucket_decline_days(v) -> str | None:
    """고점→저점 소요 거래일. 짧을수록 급락."""
    if pd.isna(v):
        return None
    v = int(v)
    if v < 40:
        return "1. 40일 미만(급락)"
    if v < 90:
        return "2. 40~89일"
    if v < 150:
        return "3. 90~149일"
    return "4. 150일 이상(완만)"


def _bucket_score(v) -> str | None:
    """점수 절대값 구간.

    순위(`_bucket_rank`)는 "그날 다른 종목들에 비해"라는 상대 기준이라, 순위별 성적
    차이가 점수 공식 때문인지 그날 경쟁자 구성 때문인지 섞인다. 절대 점수로도 같은
    방향이 나와야 "점수가 높을수록 나쁘다"고 말할 수 있다.
    """
    if pd.isna(v):
        return None
    if v < 0.50:
        return "1. 40~49점"
    if v < 0.60:
        return "2. 50~59점"
    if v < 0.70:
        return "3. 60~69점"
    return "4. 70점 이상"


def _bucket_year(v) -> str:
    """진입 연도. 구간별 차이가 사실은 시기 차이일 수 있어 따로 본다."""
    return str(pd.Timestamp(v).year)


def _bucket_rank(v) -> str:
    v = int(v)
    if v <= 5:
        return "1. 1~5위"
    if v <= 10:
        return "2. 6~10위"
    return "3. 11위 이하"


def _bool_label(v, yes: str, no: str) -> str | None:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    return yes if bool(v) else no


SEGMENTS: list[tuple[str, str]] = [
    ("저점 유지 기간별 (12번)", "seg_days_since_low"),
    ("하락 속도별 (13번)", "seg_decline_days"),
    ("50% 룰 (14번)", "seg_bull_50"),
    ("저점 높이기 (15번, 점수 미반영)", "seg_higher_low"),
    ("거래량 배지 (11번 사후검증)", "seg_volume_badge"),
    ("하락률 구간별", "seg_drawdown"),
    ("거래량비 구간별", "seg_vol_ratio"),
    ("VCP 충족 여부", "seg_vcp"),
    ("이평 정배열 여부", "seg_ma_align"),
    ("점수 순위별", "seg_rank"),
    ("점수 구간별(절대값)", "seg_score"),
    ("진입 연도별", "seg_year"),
]


def add_segment_keys(df: pd.DataFrame) -> pd.DataFrame:
    df["seg_days_since_low"] = df["days_since_low"].map(_bucket_days_since_low)
    df["seg_drawdown"] = df["drawdown_pct"].map(_bucket_drawdown)
    df["seg_vol_ratio"] = df["vol_ratio"].map(_bucket_vol_ratio)
    df["seg_decline_days"] = df["decline_days"].map(_bucket_decline_days)
    df["seg_rank"] = df["rank"].map(_bucket_rank)
    df["seg_score"] = df["score"].map(_bucket_score)
    df["seg_year"] = df["date"].map(_bucket_year)
    df["seg_vcp"] = df["vcp"].map(lambda v: _bool_label(v, "VCP 충족", "VCP 미충족"))
    df["seg_ma_align"] = df["ma_align"].map(lambda v: _bool_label(v, "이평 정배열", "정배열 아님"))
    df["seg_volume_badge"] = df["volume_badge"].map(lambda v: _bool_label(v, "배지 있음", "배지 없음"))
    df["seg_higher_low"] = df["higher_low"].map(lambda v: _bool_label(v, "저점 높임", "저점 안 높임"))
    df["seg_bull_50"] = df["bull_50_rule"].map(lambda v: _bool_label(v, "50% 회복", "회복 실패"))
    return df


def summarize(df: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict] = []

    for h in HORIZONS:
        card = _card(df, h)
        if card:
            rows.append({"구분": "전체", "구간": f"{h}거래일 보유", **card})

    for title, col in SEGMENTS:
        for key, sub in sorted(df.groupby(col, dropna=True), key=lambda kv: str(kv[0])):
            card = _card(sub, PRIMARY_HORIZON)
            if not card or card["n"] < MIN_SEGMENT_SAMPLE:
                continue
            rows.append({"구분": title, "구간": str(key), **card})

    return pd.DataFrame(rows)


def print_summary(summary: pd.DataFrame) -> None:
    if summary.empty:
        print("\n집계할 표본이 없습니다.")
        return

    print("\n" + "=" * 96)
    print(f"저점 매집 후보 — 특성별 성적 (구간별은 {PRIMARY_HORIZON}거래일 보유 기준)")
    print("=" * 96)
    print("생존 편향 때문에 절대 수치는 실제보다 좋게 나온다. 구간끼리의 비교만 볼 것.")

    for group, sub in summary.groupby("구분", sort=False):
        print(f"\n[{group}]")
        print(sub.drop(columns=["구분"]).to_string(index=False))


# ── 하락률 스윕 — "55%가 맞는 지점인가" ───────────────────────────────

@contextmanager
def _relaxed_drawdown(value: float):
    """production `_score_candidate`를 그대로 쓰되 하락률 게이트만 잠시 낮춘다.

    지표 계산을 여기서 다시 구현하지 않는 이유: 같은 값을 두 곳에서 따로 계산하면
    조용히 어긋난다(이 저장소가 반복해서 당한 사고다). 모듈 상수 하나만 바꾸면
    나머지 판정은 production과 글자 그대로 같다.

    `drawdown_score`의 기준점도 같이 움직이지만, 스윕은 점수를 쓰지 않으므로 상관없다.
    """
    original = pattern_discovery.MIN_DRAWDOWN
    pattern_discovery.MIN_DRAWDOWN = value
    try:
        yield
    finally:
        pattern_discovery.MIN_DRAWDOWN = original


def _bucket_drawdown_wide(v) -> str | None:
    """스윕용 하락률 구간 — 현재 하한(55%) **아래까지** 내려간다."""
    if pd.isna(v):
        return None
    if v < 35:
        return "1. 25~35%"
    if v < 45:
        return "2. 35~45%"
    if v < 55:
        return "3. 45~55%"
    if v < 65:
        return "4. 55~65%"
    if v < 75:
        return "5. 65~75%"
    if v < 85:
        return "6. 75~85%"
    return "7. 85% 이상"


def run_drawdown_sweep(ohlcv: dict[str, pd.DataFrame], spy: pd.Series | None) -> pd.DataFrame:
    """하락률 하한을 SWEEP_MIN_DRAWDOWN까지 낮춰 수익률 곡선의 **모양**을 본다.

    본 분석과 두 가지가 다르다:
      - **점수 하한(MIN_SCORE)을 걸지 않는다** — 점수가 55%에 고정돼 있어서 걸면
        얕은 종목이 전부 탈락한다
      - **날짜별 상위 TOP_N 선별을 하지 않는다** — 같은 이유로, 상위 20에는 얕은
        종목이 영원히 못 든다. 점수 공식과 무관하게 "하락률 자체가 성과와 어떤
        관계인가"만 본다

    나머지 하드 필터(가격 범위·저점 유지 15일·거래량 유지율·유동성)와 쿨다운은
    그대로 둔다 — 한 번에 하나만 바꿔야 원인을 알 수 있다.

    ⚠️ 생존 편향이 구간마다 다르게 걸린다. 깊게 빠진 종목일수록 그 뒤 상장폐지될
    확률이 높고 그런 종목은 오늘 유니버스에 없다. 즉 **깊은 구간일수록 생존자만
    남아 성적이 좋아 보인다.** '종목수'와 '최다종목%'를 같이 보고 걸러 읽을 것.
    """
    print(f"\n하락률 스윕 (하한 {SWEEP_MIN_DRAWDOWN:.0%}, 점수·상위선별 없음)...")
    with _relaxed_drawdown(SWEEP_MIN_DRAWDOWN):
        cand = scan(ohlcv, min_score=None)
    if cand.empty:
        print("  스윕 후보가 없습니다.")
        return pd.DataFrame()

    picks = apply_cooldown(cand)
    print(f"  쿨다운 {COOLDOWN_DAYS}일 적용 → {len(picks)}건")
    picks = add_benchmark(picks, spy)
    picks["seg_dd"] = picks["drawdown_pct"].map(_bucket_drawdown_wide)

    rows: list[dict] = []
    for horizon in (PRIMARY_HORIZON, 250):
        for key, sub in sorted(picks.groupby("seg_dd", dropna=True), key=lambda kv: str(kv[0])):
            card = _card(sub, horizon)
            if not card or card["n"] < MIN_SEGMENT_SAMPLE:
                continue
            rows.append({"구분": f"하락률 구간 ({horizon}거래일 보유)", "구간": str(key), **card})

    summary = pd.DataFrame(rows)
    if summary.empty:
        print("  집계할 표본이 없습니다.")
        return summary

    print("\n" + "=" * 96)
    print(f"하락률 스윕 — 현재 하한 55%가 맞는 지점인가 (하한을 {SWEEP_MIN_DRAWDOWN:.0%}로 낮춰 재생)")
    print("=" * 96)
    print("⚠️ 깊은 구간일수록 생존 편향이 세다(망한 종목이 유니버스에 없다).")
    print("   '종목수'가 적거나 '최다종목%'가 크면 그 구간 숫자는 조건이 아니라 특정 종목의 성적이다.")
    for group, sub in summary.groupby("구분", sort=False):
        print(f"\n[{group}]")
        print(sub.drop(columns=["구분"]).to_string(index=False))

    summary.to_csv(SWEEP_SUMMARY_CSV, index=False)
    picks.to_csv(SWEEP_TRADES_CSV, index=False)
    print(f"\n저장: {SWEEP_TRADES_CSV.name} ({len(picks)}건) / {SWEEP_SUMMARY_CSV.name}")
    return summary


def main() -> None:
    tickers = get_universe()
    if not tickers:
        print("유니버스가 비었습니다 — 소스가 막혔는지 확인할 것.")
        return

    ohlcv = download_ohlcv(tickers)
    if not ohlcv:
        print("가격 데이터를 받지 못했습니다.")
        return

    print("\n워크포워드 채점 중...")
    candidates = scan(ohlcv)
    if candidates.empty:
        print("자격 후보가 없습니다.")
        return

    spy = download_spy()
    picks = select_screen_candidates(candidates)
    picks = add_benchmark(picks, spy)
    picks = add_segment_keys(picks)

    summary = summarize(picks)
    print_summary(summary)

    picks.to_csv(TRADES_CSV, index=False)
    summary.to_csv(SUMMARY_CSV, index=False)
    print(f"\n저장: {TRADES_CSV.name} ({len(picks)}건) / {SUMMARY_CSV.name}")

    # 같은 다운로드를 재활용해 스윕까지 한 번에 돌린다(스캔은 수십 초라 부담 없다).
    run_drawdown_sweep(ohlcv, spy)


if __name__ == "__main__":
    main()
