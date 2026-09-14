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
  15번 저점 높이기(`higher_low`)      — 저점 '미하향'만 보는 지금보다 나은가
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
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

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

HIGHER_LOW_SPAN = 20     # 저점 높이기 비교 구간(거래일). supportSignals.ts와 같은 길이

OUT_DIR = Path(__file__).parent
CACHE_DIR = OUT_DIR / "_cache"
TRADES_CSV = OUT_DIR / "backtest_pattern_features_trades.csv"
SUMMARY_CSV = OUT_DIR / "backtest_pattern_features_summary.csv"


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


def _higher_low(w_low: np.ndarray, span: int = HIGHER_LOW_SPAN) -> bool | None:
    """최근 span봉 저점이 그 직전 span봉 저점보다 높은가 (15번).

    지금 점수는 저점을 '안 깨는 기간'만 본다. 책은 역헤드앤숄더를 "저점을 **높이며**
    거래량 증가"로 설명한다 — 같은 15일이라도 바닥을 기는 것과 들어올리는 것은 다르다.
    """
    if len(w_low) < 2 * span:
        return None
    return bool(w_low[-span:].min() > w_low[-2 * span : -span].min())


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

def scan(ohlcv: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """모든 거래일 × 모든 종목을 채점해 자격 후보를 모은다 (lookahead 없음)."""
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
            if not ok or stats["score"] < MIN_SCORE:
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
                # 아직 점수에 안 들어간 후보 지표
                "volume_badge": _is_volume_trigger_today(w_open, w_high, w_low, w_close, w_vol),
                "decline_days": _decline_days(w_high, w_close),
                "higher_low": _higher_low(w_low),
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

    # 같은 종목이 바닥 구간 내내 매일 뽑히므로 쿨다운으로 솎는다. 아예 첫 등장만
    # 남기면 days_since_low가 항상 하한(15일) 근처라 12번을 판정할 변화가 사라진다 —
    # 30일 간격이면 같은 종목이 15일·45일·75일…로 다시 들어와 구간이 채워진다.
    kept: list[int] = []
    last_seen: dict[str, pd.Timestamp] = {}
    for idx, ticker, date in zip(ranked.index, ranked["ticker"], ranked["date"]):
        ts = pd.Timestamp(date)
        prev = last_seen.get(ticker)
        if prev is not None and (ts - prev).days < COOLDOWN_DAYS:
            continue
        last_seen[ticker] = ts
        kept.append(idx)

    out = ranked.loc[kept]
    print(f"  화면 기준(상위 {TOP_N} + 쿨다운 {COOLDOWN_DAYS}일) 적용 → {len(out)}건")
    return out


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
    화면이 다른 말을 하면 어느 쪽을 믿을지 알 수 없다."""
    rets = sub[f"ret_{horizon}d_pct"].dropna()
    if rets.empty:
        return {}
    excess_col = f"excess_{horizon}d_pct"
    excess = sub[excess_col].dropna() if excess_col in sub.columns else pd.Series(dtype=float)
    return {
        "n": len(rets),
        "평균%": round(rets.mean(), 2),
        "중간값%": round(rets.median(), 2),
        "승률%": round((rets > 0).mean() * 100, 1),
        f"+{BIG_MOVE_PCT}%이상": round((rets >= BIG_MOVE_PCT).mean() * 100, 1),
        f"-{BIG_MOVE_PCT}%이하": round((rets <= -BIG_MOVE_PCT).mean() * 100, 1),
        "SPY대비%": round(excess.mean(), 2) if not excess.empty else None,
    }


def _bucket_days_since_low(v) -> str | None:
    if pd.isna(v):
        return None
    v = int(v)
    if v < 30:
        return "1. 15~29일"
    if v < 45:
        return "2. 30~44일"
    if v < 60:
        return "3. 45~59일"
    return "4. 60일 이상"


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
    ("저점 높이기 (15번)", "seg_higher_low"),
    ("거래량 배지 (11번 사후검증)", "seg_volume_badge"),
    ("하락률 구간별", "seg_drawdown"),
    ("VCP 충족 여부", "seg_vcp"),
    ("이평 정배열 여부", "seg_ma_align"),
    ("점수 순위별", "seg_rank"),
]


def add_segment_keys(df: pd.DataFrame) -> pd.DataFrame:
    df["seg_days_since_low"] = df["days_since_low"].map(_bucket_days_since_low)
    df["seg_drawdown"] = df["drawdown_pct"].map(_bucket_drawdown)
    df["seg_decline_days"] = df["decline_days"].map(_bucket_decline_days)
    df["seg_rank"] = df["rank"].map(_bucket_rank)
    df["seg_vcp"] = df["vcp"].map(lambda v: _bool_label(v, "VCP 충족", "VCP 미충족"))
    df["seg_ma_align"] = df["ma_align"].map(lambda v: _bool_label(v, "정배열", "정배열 아님"))
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

    picks = select_screen_candidates(candidates)
    picks = add_benchmark(picks, download_spy())
    picks = add_segment_keys(picks)

    summary = summarize(picks)
    print_summary(summary)

    picks.to_csv(TRADES_CSV, index=False)
    summary.to_csv(SUMMARY_CSV, index=False)
    print(f"\n저장: {TRADES_CSV.name} ({len(picks)}건) / {SUMMARY_CSV.name}")


if __name__ == "__main__":
    main()
