from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Callable

import pandas as pd

from . import prices_kr, prices_us, sectors, universe_kr, universe_us
from .indicators import rsi
from .market_regime import determine_market_regime
from .screener import evaluate_pullback

SECTOR_DETECTION_LOOKBACK_DAYS = 45
# 380 calendar days ≈ 263 trading days — 200일 SMA 계산에 필요한 최소 거래일을 확보.
FULL_HISTORY_LOOKBACK_DAYS = 380
# 380 calendar days ≈ 263 trading days — covers full 52-week high via KIS pagination.
US_UNIVERSE_HISTORY_LOOKBACK_DAYS = 380
INDEX_LOOKBACK_DAYS = 400
KR_MIN_MARKET_CAP = 300_000_000_000
# $20억 — S&P600 하단의 저유동성 꼬리를 잘라내는 실질적 하한 (KR 3,000억원과 시장 규모 대비 유사한 깊이)
US_MIN_MARKET_CAP = 2_000_000_000
# 눌림목 스크리너 대상 지수 (S&P 1500 + NASDAQ 100). Russell3000 단독 편입 종목은 패턴 매칭 전용.
US_SCREENER_INDEXES = ["S&P500", "NASDAQ100", "S&P400", "S&P600"]
# 초대형주 섹터 게이트 면제 기준. 지수 주도 초대형주가 눌림목에 들어가면 자기 섹터의
# 5일 모멘텀을 끌어내려 주도 섹터에서 빠지는 구조적 맹점이 있어, 이 기준 이상은
# 주도 섹터 소속과 무관하게 눌림목 필터만으로 판단한다.
KR_MEGA_CAP = 20_000_000_000_000  # 20조원
US_MEGA_CAP = 200_000_000_000  # $2,000억
# 전 조건 통과 종목이 5개 미만인 날, 미달 조건이 가장 적은 근접 종목으로 채워
# 매일 최소 5개(후보가 있는 한)를 보여준다. 근접 종목은 passed=False로 구분.
TOP_CANDIDATES = 5
# 하락장 날 모든 후보에 붙는 시장 단위 미달 조건 (종목 조건과 동일한 목록에 표시)
MARKET_BEAR_CRITERION = "시장 하락장"


@dataclass
class ScreenedStock:
    ticker: str
    name: str
    sector: str
    close: float
    market_cap: float
    rsi: float
    as_of: date
    passed: bool = True
    failed_criteria: list[str] = field(default_factory=list)


@dataclass
class MarketPipelineResult:
    market: str
    regime: str
    as_of: date
    leading_sectors: list[str] = field(default_factory=list)
    screened_stocks: list[ScreenedStock] = field(default_factory=list)
    price_history: dict[str, pd.DataFrame] = field(default_factory=dict)
    universe_df: pd.DataFrame = field(default_factory=pd.DataFrame)


def _as_of_date(idx) -> date:
    """실제로 가져온 마지막 봉의 날짜. wall-clock `today`와 다를 수 있다
    (파이프라인 실행 시각이 늦어져 그날 종가까지 이미 포함된 경우 등)."""
    return idx.date() if hasattr(idx, "date") else idx


def _build_sector_frame(universe: pd.DataFrame, recent_histories: dict[str, pd.DataFrame]) -> pd.DataFrame:
    rows = []
    for _, row in universe.iterrows():
        ticker = row["ticker"]
        hist = recent_histories.get(ticker)
        if hist is None or hist.empty:
            continue
        for idx, price_row in hist.iterrows():
            rows.append({
                "ticker": ticker, "sector": row["sector"], "date": idx,
                "close": price_row["Close"], "volume": price_row["Volume"],
            })
    return pd.DataFrame(rows)


def _screen_candidates(
    candidates: pd.DataFrame,
    fetch_full_history: Callable[[str], pd.DataFrame],
    require_sma200: bool = False,
    extra_failures: list[str] | None = None,
) -> tuple[list[ScreenedStock], dict[str, pd.DataFrame]]:
    """전 조건 통과 종목 전부 + 미달이 가장 적은 근접 종목으로 TOP_CANDIDATES까지 채운다.

    extra_failures: 시장 단위 미달 조건(예: 하락장). 모든 후보의 failed_criteria에
    더해지므로, 하락장 날은 전 종목이 passed=False가 되어 이력/성적표 집계
    (passed=true 필터)에는 잡히지 않으면서 화면에는 상위 후보가 표시된다.
    """
    evaluated: list[tuple[float, ScreenedStock, pd.DataFrame]] = []
    for _, row in candidates.iterrows():
        ticker = row["ticker"]
        hist = fetch_full_history(ticker)
        if hist.empty:
            continue
        ev = evaluate_pullback(
            hist["Close"], hist["Volume"], hist["High"], require_sma200=require_sma200,
        )
        if ev is None:
            continue
        failed = list(extra_failures or []) + ev.failed
        evaluated.append((
            ev.impulse_gain,
            ScreenedStock(
                ticker=ticker,
                name=row["name"],
                # 나스닥100 단독 편입 초대형주(예: ASML)는 S&P500에 없어 섹터가 None으로
                # 남는데, 초대형주 섹터 게이트 면제로 여기까지 통과한다. screened_stocks.sector
                # 는 NOT NULL이므로 None이면 "Unknown"으로 대체해 DB upsert 크래시를 막는다.
                sector=row["sector"] if pd.notna(row["sector"]) else "Unknown",
                close=float(hist["Close"].iloc[-1]),
                market_cap=float(row["market_cap"]),
                rsi=float(rsi(hist["Close"]).iloc[-1]),
                as_of=_as_of_date(hist.index[-1]),
                passed=not failed,
                failed_criteria=failed,
            ),
            hist,
        ))

    # 미달 조건 적은 순 → 선행 상승(임팩트) 큰 순
    evaluated.sort(key=lambda t: (len(t[1].failed_criteria), -t[0]))
    passers = [t for t in evaluated if t[1].passed]
    near_misses = [t for t in evaluated if not t[1].passed]
    selected = passers + near_misses[: max(0, TOP_CANDIDATES - len(passers))]

    screened = [stock for _, stock, _ in selected]
    price_history = {stock.ticker: hist.tail(120) for _, stock, hist in selected}
    return screened, price_history


def run_kr_pipeline(today: date) -> MarketPipelineResult:
    universe = universe_kr.get_kr_universe(min_market_cap=KR_MIN_MARKET_CAP)

    index_close = prices_kr.get_kospi_index_history(today, INDEX_LOOKBACK_DAYS)
    regime = determine_market_regime(index_close)

    recent_histories = {
        ticker: prices_kr.get_kr_stock_history(ticker, today, SECTOR_DETECTION_LOOKBACK_DAYS)
        for ticker in universe["ticker"]
    }
    sector_df = _build_sector_frame(universe, recent_histories)
    top_sectors = sectors.leading_sectors(sector_df, top_n=5) if not sector_df.empty else []

    # require_sma200=True: 200일 이평선 위에 있는 종목만 — 장기 하락 추세 종목 원천 차단 (US와 동일)
    # 하락장에도 상위 후보는 랭킹으로 보여주되 "시장 하락장" 미달 조건을 달아
    # passed=False로 저장한다 (매수 신호 아님 표시 + 이력 집계 제외).
    sector_gate = universe["sector"].isin(top_sectors) | (universe["market_cap"] >= KR_MEGA_CAP)
    candidates = universe[sector_gate & universe["meets_cap_threshold"]]
    screened, price_history = _screen_candidates(
        candidates, lambda t: prices_kr.get_kr_stock_history(t, today, FULL_HISTORY_LOOKBACK_DAYS),
        require_sma200=True,
        extra_failures=[] if regime == "bull" else [MARKET_BEAR_CRITERION],
    )

    return MarketPipelineResult(
        market="KR", regime=regime, as_of=_as_of_date(index_close.index[-1]),
        leading_sectors=top_sectors,
        screened_stocks=screened, price_history=price_history,
        universe_df=universe,
    )


def run_us_pipeline(today: date) -> MarketPipelineResult:
    universe = universe_us.get_us_universe()
    market_caps = prices_us.get_us_market_caps(universe["ticker"].tolist())
    universe = universe.copy()
    universe["market_cap"] = universe["ticker"].map(market_caps).fillna(0.0)
    universe["meets_cap_threshold"] = universe["market_cap"] >= US_MIN_MARKET_CAP

    index_close = prices_us.get_sp500_index_history(today, INDEX_LOOKBACK_DAYS)
    regime = determine_market_regime(index_close)

    # KIS API는 순차 호출이므로 스크리너 대상(S&P1500+NASDAQ100, ~1,500종목)만 다운로드.
    # Russell 3000 단독 편입 종목 히스토리는 main.py에서 yfinance 배치로 별도 수집 (패턴 매칭용).
    screener_mask = universe["index_membership"].isin(US_SCREENER_INDEXES)
    screener_tickers = universe.loc[screener_mask, "ticker"].tolist()
    all_histories = prices_us.get_us_stock_histories(
        screener_tickers, today, US_UNIVERSE_HISTORY_LOOKBACK_DAYS,
    )
    sector_df = _build_sector_frame(universe[screener_mask], all_histories)
    top_sectors = sectors.leading_sectors(sector_df, top_n=5) if not sector_df.empty else []

    # 눌림목 스크리너: S&P1500+NASDAQ100 대상 (Russell 3000 단독 편입 소형주 제외)
    # require_sma200=True: 200일 이평선 위에 있는 종목만 — 장기 하락 추세 종목 원천 차단
    # 하락장에도 상위 후보는 랭킹으로 보여주되 "시장 하락장" 미달로 passed=False 저장.
    sector_gate = universe["sector"].isin(top_sectors) | (universe["market_cap"] >= US_MEGA_CAP)
    candidates = universe[screener_mask & sector_gate & universe["meets_cap_threshold"]]
    screened, _ = _screen_candidates(
        candidates, lambda t: all_histories.get(t, pd.DataFrame()), require_sma200=True,
        extra_failures=[] if regime == "bull" else [MARKET_BEAR_CRITERION],
    )

    return MarketPipelineResult(
        market="US", regime=regime, as_of=_as_of_date(index_close.index[-1]),
        leading_sectors=top_sectors,
        screened_stocks=screened,
        price_history=all_histories,
        universe_df=universe,
    )
