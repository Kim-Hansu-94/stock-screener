# 주식 스크리너 — 데이터 파이프라인 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 한국(KRX)·미국(S&P500+나스닥100) 주식 데이터를 매일 수집해 시장분위기·주도섹터·눌림목 필터 결과를 계산하고 Supabase에 저장하는 Python 파이프라인을 만든다.

**Architecture:** 순수 계산 로직(지표, 시장분위기, 주도섹터, 눌림목 필터)과 외부 데이터 소스(FinanceDataReader, yfinance) 접근 로직을 분리한다. 순수 로직은 TDD로 단위 테스트하고, 외부 데이터 소스 래퍼는 mock을 이용해 변환 로직만 테스트한다. 오케스트레이션(`pipeline.py`)이 이 둘을 조합해 시장별 결과를 만들고, `main.py`가 Supabase에 저장한다. GitHub Actions가 매일 8:30 KST에 `main.py`를 실행한다.

**Tech Stack:** Python 3.12, pandas, FinanceDataReader, yfinance, supabase-py, pytest, GitHub Actions.

## Global Constraints

- 스펙 문서: `docs/superpowers/specs/2026-06-25-stock-screener-design.md` (이 계획의 모든 수치 기준은 이 문서에서 가져옴)
- 한국 시가총액 기준: 3,000억 원(300,000,000,000) 이상
- 미국 시가총액 기준: 2억 달러(200,000,000) 이상
- 미국 종목 범위: S&P500 + 나스닥100 구성종목
- 눌림목 필터: 60일선 우상향+가격 위 / 5일선 아래·20일선 -3% 이내 / RSI(14) 40~55 / 최근5일 평균거래량 < 직전20일 평균거래량
- "우상향" 공통 정의: 이동평균선 값이 5거래일 전보다 높음
- 시장분위기: 종가 > 50일선, 50일선 > 200일선 → "bull", 그 외 "bear"
- 주도섹터: 최근 5일 평균 거래액(종가×거래량) 상위, 5일 모멘텀(평균종가 변화) 양수인 섹터 중 상위 3개
- 일정: 매일 8:30 KST = 23:30 UTC(전날), GitHub Actions cron 사용
- 모든 신규 Python 코드는 `pipeline/` 디렉터리 아래에 위치
- 커밋 작성자: `git config user.email "hansu2003kr@naver.com"`, `git config user.name "김한수"` (이미 리포지토리에 설정됨)

---

## 사전 준비 (사용자 작업, 코드 작업 아님)

이 계획을 실행하기 전에 사용자가 직접 해야 하는 일:

1. [supabase.com](https://supabase.com)에서 무료 계정 가입 후 새 프로젝트 생성
2. 프로젝트의 **Project URL**과 **service_role 키**를 확보 (Project Settings → API)
3. Task 2에서 만들 `supabase/schema.sql`을 Supabase 대시보드의 SQL Editor에서 실행해 테이블 생성
4. 로컬 개발용으로 `pipeline/.env` 파일에 `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`를 넣음 (`.env.example`을 참고)
5. GitHub 리포지토리를 만들고(아직 없다면) `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`를 리포지토리 Settings → Secrets and variables → Actions에 등록 (Task 14에서 필요)

---

### Task 1: 파이프라인 프로젝트 스캐폴딩

**Files:**
- Create: `pipeline/requirements.txt`
- Create: `pipeline/src/__init__.py`
- Create: `pipeline/tests/__init__.py`
- Create: `pipeline/pytest.ini`
- Create: `.gitignore`

**Interfaces:**
- Produces: `pipeline/` 패키지 구조, 이후 모든 task가 이 안에 파일을 추가함

- [ ] **Step 1: 디렉터리와 requirements.txt 작성**

```text
pandas
FinanceDataReader
yfinance
supabase
requests
python-dotenv
pytest
```

위 내용을 `pipeline/requirements.txt`에 저장.

- [ ] **Step 2: 패키지 init 파일 및 pytest 설정 작성**

`pipeline/src/__init__.py` (빈 파일), `pipeline/tests/__init__.py` (빈 파일) 생성.

`pipeline/pytest.ini`:
```ini
[pytest]
testpaths = pipeline/tests
pythonpath = .
```

- [ ] **Step 3: .gitignore 작성**

```text
__pycache__/
*.pyc
.env
pipeline/.env
.venv/
```

- [ ] **Step 4: 의존성 설치 확인**

Run: `pip install -r pipeline/requirements.txt`
Expected: 에러 없이 설치 완료 (이미 설치된 패키지는 "Requirement already satisfied" 출력)

- [ ] **Step 5: pytest가 빈 테스트 스위트를 인식하는지 확인**

Run: `pytest pipeline/tests -v`
Expected: `no tests ran` (에러 없이 종료)

- [ ] **Step 6: Commit**

```bash
git add pipeline/requirements.txt pipeline/src/__init__.py pipeline/tests/__init__.py pipeline/pytest.ini .gitignore
git commit -m "Scaffold pipeline package structure"
```

---

### Task 2: Supabase 스키마 작성

**Files:**
- Create: `supabase/schema.sql`
- Create: `pipeline/.env.example`

**Interfaces:**
- Produces: 4개 테이블(`market_regime`, `leading_sectors`, `screened_stocks`, `stock_price_history`) — Task 11(db.py)이 이 스키마에 맞춰 upsert 작성

- [ ] **Step 1: 스키마 SQL 작성**

`supabase/schema.sql`:
```sql
create table if not exists market_regime (
  date date not null,
  market text not null check (market in ('KR', 'US')),
  regime text not null check (regime in ('bull', 'bear')),
  primary key (date, market)
);

create table if not exists leading_sectors (
  date date not null,
  market text not null check (market in ('KR', 'US')),
  sector text not null,
  rank int not null,
  primary key (date, market, sector)
);

create table if not exists screened_stocks (
  date date not null,
  market text not null check (market in ('KR', 'US')),
  ticker text not null,
  name text not null,
  sector text not null,
  close numeric not null,
  market_cap numeric not null,
  rsi numeric not null,
  primary key (date, market, ticker)
);

create table if not exists stock_price_history (
  ticker text not null,
  market text not null check (market in ('KR', 'US')),
  date date not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume bigint not null,
  primary key (ticker, market, date)
);
```

- [ ] **Step 2: .env 예시 파일 작성**

`pipeline/.env.example`:
```text
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
```

- [ ] **Step 3: 사용자에게 Supabase 대시보드 SQL Editor에서 `supabase/schema.sql` 실행 요청**

(사람이 직접 해야 하는 단계 — 위 "사전 준비" 섹션 3번 항목)

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql pipeline/.env.example
git commit -m "Add Supabase schema for screener tables"
```

---

### Task 3: indicators.py — 기술지표 순수 함수

**Files:**
- Create: `pipeline/src/indicators.py`
- Test: `pipeline/tests/test_indicators.py`

**Interfaces:**
- Produces:
  - `sma(series: pd.Series, window: int) -> pd.Series`
  - `rsi(series: pd.Series, window: int = 14) -> pd.Series`
  - `is_trending_up(ma_series: pd.Series, lookback: int = 5) -> bool`
  - `volume_ratio(volume: pd.Series, recent_window: int = 5, baseline_window: int = 20) -> float`
- Consumes: 외부 의존성 없음 (pandas만 사용)

- [ ] **Step 1: 실패하는 테스트 작성**

`pipeline/tests/test_indicators.py`:
```python
import pandas as pd
import numpy as np
import pytest

from pipeline.src.indicators import sma, rsi, is_trending_up, volume_ratio


def test_sma_computes_rolling_mean():
    series = pd.Series([1, 2, 3, 4, 5])
    result = sma(series, window=2)
    assert result.iloc[-1] == pytest.approx(4.5)
    assert pd.isna(result.iloc[0])


def test_rsi_is_100_when_all_gains():
    series = pd.Series(range(1, 21))  # steadily increasing, no losses
    result = rsi(series, window=14)
    assert result.iloc[-1] == pytest.approx(100.0)


def test_rsi_is_0_when_all_losses():
    series = pd.Series(range(20, 0, -1))  # steadily decreasing, no gains
    result = rsi(series, window=14)
    assert result.iloc[-1] == pytest.approx(0.0)


def test_is_trending_up_true_when_ma_higher_than_lookback():
    ma_series = pd.Series([1, 2, 3, 4, 5, 6, 7])
    assert is_trending_up(ma_series, lookback=5) is True


def test_is_trending_up_false_when_ma_lower_than_lookback():
    ma_series = pd.Series([7, 6, 5, 4, 3, 2, 1])
    assert is_trending_up(ma_series, lookback=5) is False


def test_is_trending_up_false_when_not_enough_history():
    ma_series = pd.Series([1, 2, 3])
    assert is_trending_up(ma_series, lookback=5) is False


def test_volume_ratio_below_one_when_recent_volume_lower():
    volume = pd.Series([100.0] * 20 + [50.0] * 5)
    result = volume_ratio(volume, recent_window=5, baseline_window=20)
    assert result == pytest.approx(0.5)


def test_volume_ratio_above_one_when_recent_volume_higher():
    volume = pd.Series([100.0] * 20 + [150.0] * 5)
    result = volume_ratio(volume, recent_window=5, baseline_window=20)
    assert result == pytest.approx(1.5)
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `pytest pipeline/tests/test_indicators.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.src.indicators'`

- [ ] **Step 3: 최소 구현 작성**

`pipeline/src/indicators.py`:
```python
from __future__ import annotations

import pandas as pd


def sma(series: pd.Series, window: int) -> pd.Series:
    return series.rolling(window=window).mean()


def rsi(series: pd.Series, window: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.rolling(window=window).mean()
    avg_loss = loss.rolling(window=window).mean()
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def is_trending_up(ma_series: pd.Series, lookback: int = 5) -> bool:
    valid = ma_series.dropna()
    if len(valid) <= lookback:
        return False
    return bool(ma_series.iloc[-1] > ma_series.iloc[-1 - lookback])


def volume_ratio(volume: pd.Series, recent_window: int = 5, baseline_window: int = 20) -> float:
    recent_avg = volume.iloc[-recent_window:].mean()
    baseline_avg = volume.iloc[-(recent_window + baseline_window):-recent_window].mean()
    return float(recent_avg / baseline_avg)
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `pytest pipeline/tests/test_indicators.py -v`
Expected: 8개 테스트 모두 PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/indicators.py pipeline/tests/test_indicators.py
git commit -m "Add technical indicator functions (sma, rsi, trend, volume ratio)"
```

---

### Task 4: market_regime.py — 시장분위기 판단

**Files:**
- Create: `pipeline/src/market_regime.py`
- Test: `pipeline/tests/test_market_regime.py`

**Interfaces:**
- Consumes: `indicators.sma`
- Produces: `determine_market_regime(close: pd.Series) -> str` (반환값은 `"bull"` 또는 `"bear"`)

- [ ] **Step 1: 실패하는 테스트 작성**

`pipeline/tests/test_market_regime.py`:
```python
import numpy as np
import pandas as pd

from pipeline.src.market_regime import determine_market_regime


def test_bull_when_close_above_sma50_above_sma200():
    close = pd.Series(100 + np.linspace(0, 100, 250))
    assert determine_market_regime(close) == "bull"


def test_bear_when_downtrend():
    close = pd.Series(200 - np.linspace(0, 100, 250))
    assert determine_market_regime(close) == "bear"


def test_bear_when_not_enough_history_for_sma200():
    close = pd.Series(100 + np.linspace(0, 10, 100))
    assert determine_market_regime(close) == "bear"
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `pytest pipeline/tests/test_market_regime.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.src.market_regime'`

- [ ] **Step 3: 최소 구현 작성**

`pipeline/src/market_regime.py`:
```python
from __future__ import annotations

import pandas as pd

from .indicators import sma


def determine_market_regime(close: pd.Series) -> str:
    sma50 = sma(close, 50)
    sma200 = sma(close, 200)

    latest_sma200 = sma200.iloc[-1]
    if pd.isna(latest_sma200):
        return "bear"

    latest_close = close.iloc[-1]
    latest_sma50 = sma50.iloc[-1]
    if latest_close > latest_sma50 and latest_sma50 > latest_sma200:
        return "bull"
    return "bear"
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `pytest pipeline/tests/test_market_regime.py -v`
Expected: 3개 테스트 모두 PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/market_regime.py pipeline/tests/test_market_regime.py
git commit -m "Add market regime detection (bull/bear)"
```

---

### Task 5: sectors.py — 주도섹터 탐지

**Files:**
- Create: `pipeline/src/sectors.py`
- Test: `pipeline/tests/test_sectors.py`

**Interfaces:**
- Consumes: 없음 (pandas만 사용)
- Produces: `leading_sectors(df: pd.DataFrame, top_n: int = 3, window: int = 5) -> list[str]`
  - `df`는 컬럼 `ticker, sector, date, close, volume`을 가진 long-format DataFrame (종목×날짜별 1행)

- [ ] **Step 1: 실패하는 테스트 작성**

`pipeline/tests/test_sectors.py`:
```python
import pandas as pd

from pipeline.src.sectors import leading_sectors


def _build_fixture() -> pd.DataFrame:
    dates = pd.date_range("2024-01-01", periods=6)
    rows = []
    # Sector A: 거래액 높음 + 가격 상승(양의 모멘텀) -> 주도섹터 후보
    for i, d in enumerate(dates):
        rows.append({"ticker": "A1", "sector": "A", "date": d, "close": 100 + i, "volume": 1_000_000})
        rows.append({"ticker": "A2", "sector": "A", "date": d, "close": 50 + i * 0.5, "volume": 800_000})
    # Sector B: 거래액 높음 but 가격 하락(음의 모멘텀) -> 제외되어야 함
    for i, d in enumerate(dates):
        rows.append({"ticker": "B1", "sector": "B", "date": d, "close": 200 - i * 3, "volume": 1_200_000})
    # Sector C: 거래액 낮음 + 가격 상승 -> 후보지만 순위는 A보다 낮음
    for i, d in enumerate(dates):
        rows.append({"ticker": "C1", "sector": "C", "date": d, "close": 30 + i * 0.2, "volume": 100_000})
    return pd.DataFrame(rows)


def test_excludes_sector_with_negative_momentum():
    df = _build_fixture()
    result = leading_sectors(df, top_n=3)
    assert result == ["A", "C"]


def test_respects_top_n():
    df = _build_fixture()
    result = leading_sectors(df, top_n=1)
    assert result == ["A"]


def test_drops_rows_with_missing_sector():
    df = _build_fixture()
    extra = pd.DataFrame([
        {"ticker": "X1", "sector": None, "date": d, "close": 1000, "volume": 5_000_000}
        for d in pd.date_range("2024-01-01", periods=6)
    ])
    df = pd.concat([df, extra], ignore_index=True)
    result = leading_sectors(df, top_n=3)
    assert "X1" not in result
    assert result == ["A", "C"]
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `pytest pipeline/tests/test_sectors.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.src.sectors'`

- [ ] **Step 3: 최소 구현 작성**

`pipeline/src/sectors.py`:
```python
from __future__ import annotations

import pandas as pd


def leading_sectors(df: pd.DataFrame, top_n: int = 3, window: int = 5) -> list[str]:
    df = df.dropna(subset=["sector"]).sort_values("date")
    if df.empty:
        return []

    recent_dates = df["date"].drop_duplicates().sort_values().iloc[-window:]
    recent = df[df["date"].isin(recent_dates)].copy()
    recent["trading_value"] = recent["close"] * recent["volume"]
    trading_value_by_sector = recent.groupby("sector")["trading_value"].mean()

    first_date = recent_dates.iloc[0]
    last_date = recent_dates.iloc[-1]
    avg_close_first = df[df["date"] == first_date].groupby("sector")["close"].mean()
    avg_close_last = df[df["date"] == last_date].groupby("sector")["close"].mean()
    momentum = (avg_close_last / avg_close_first) - 1

    positive_momentum = momentum.reindex(trading_value_by_sector.index) > 0
    candidates = trading_value_by_sector[positive_momentum]
    return candidates.sort_values(ascending=False).head(top_n).index.tolist()
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `pytest pipeline/tests/test_sectors.py -v`
Expected: 3개 테스트 모두 PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/sectors.py pipeline/tests/test_sectors.py
git commit -m "Add leading sector detection"
```

---

### Task 6: screener.py — 눌림목 매수 필터

**Files:**
- Create: `pipeline/src/screener.py`
- Test: `pipeline/tests/test_screener.py`

**Interfaces:**
- Consumes: `indicators.sma`, `indicators.rsi`, `indicators.is_trending_up`, `indicators.volume_ratio`
- Produces: `passes_pullback_filter(close: pd.Series, volume: pd.Series) -> bool`

- [ ] **Step 1: 실패하는 테스트 작성**

`pipeline/tests/test_screener.py`:
```python
import numpy as np
import pandas as pd

from pipeline.src.screener import passes_pullback_filter

N_UP_DAYS = 95


def _uptrend_with_pullback(drop_pct: float, volume_pullback) -> tuple[pd.Series, pd.Series]:
    base = 100 + np.linspace(0, 40, N_UP_DAYS)
    peak = base[-1]
    total_drop = peak * drop_pct
    pullback_days = [
        peak - total_drop * 0.3,
        peak - total_drop * 0.55,
        peak - total_drop * 0.75,
        peak - total_drop * 0.9,
        peak - total_drop,
    ]
    close = pd.Series(list(base) + pullback_days)
    volume = pd.Series([1_000_000.0] * N_UP_DAYS + list(volume_pullback))
    return close, volume


def test_passes_when_healthy_pullback_in_uptrend():
    close, volume = _uptrend_with_pullback(
        drop_pct=0.030,
        volume_pullback=[600_000, 550_000, 500_000, 480_000, 450_000],
    )
    assert passes_pullback_filter(close, volume) is True


def test_fails_when_rsi_too_low_oversold():
    close, volume = _uptrend_with_pullback(
        drop_pct=0.07,
        volume_pullback=[600_000, 550_000, 500_000, 480_000, 450_000],
    )
    assert passes_pullback_filter(close, volume) is False


def test_fails_when_no_pullback_rsi_too_high():
    close, volume = _uptrend_with_pullback(
        drop_pct=0.005,
        volume_pullback=[600_000, 550_000, 500_000, 480_000, 450_000],
    )
    assert passes_pullback_filter(close, volume) is False


def test_fails_when_volume_increasing_during_pullback():
    close, volume = _uptrend_with_pullback(
        drop_pct=0.030,
        volume_pullback=[1_200_000, 1_250_000, 1_300_000, 1_350_000, 1_400_000],
    )
    assert passes_pullback_filter(close, volume) is False


def test_fails_when_long_term_trend_is_down():
    base_down = 140 - np.linspace(0, 40, N_UP_DAYS)
    peak = base_down[-1]
    down_tail = [peak - 0.5, peak - 1.0, peak - 1.3, peak - 1.5, peak - 1.6]
    close = pd.Series(list(base_down) + down_tail)
    volume = pd.Series([1_000_000.0] * N_UP_DAYS + [600_000, 550_000, 500_000, 480_000, 450_000])
    assert passes_pullback_filter(close, volume) is False


def test_fails_when_not_enough_history():
    close = pd.Series(100 + np.linspace(0, 10, 50))
    volume = pd.Series([1_000_000.0] * 50)
    assert passes_pullback_filter(close, volume) is False
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `pytest pipeline/tests/test_screener.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.src.screener'`

- [ ] **Step 3: 최소 구현 작성**

`pipeline/src/screener.py`:
```python
from __future__ import annotations

import pandas as pd

from .indicators import is_trending_up, rsi, sma, volume_ratio

MIN_HISTORY_DAYS = 85
LONG_TERM_WINDOW = 60
SHORT_TERM_WINDOW = 5
MID_TERM_WINDOW = 20
RSI_WINDOW = 14
RSI_LOW = 40
RSI_HIGH = 55
PULLBACK_TOLERANCE = 0.97


def passes_pullback_filter(close: pd.Series, volume: pd.Series) -> bool:
    if len(close) < MIN_HISTORY_DAYS:
        return False

    sma5 = sma(close, SHORT_TERM_WINDOW)
    sma20 = sma(close, MID_TERM_WINDOW)
    sma60 = sma(close, LONG_TERM_WINDOW)
    rsi14 = rsi(close, RSI_WINDOW)

    latest_close = close.iloc[-1]
    latest_sma60 = sma60.iloc[-1]
    latest_rsi = rsi14.iloc[-1]

    if pd.isna(latest_sma60) or pd.isna(latest_rsi):
        return False

    long_term_up = is_trending_up(sma60, lookback=SHORT_TERM_WINDOW) and latest_close > latest_sma60
    pullback = latest_close < sma5.iloc[-1] and latest_close >= sma20.iloc[-1] * PULLBACK_TOLERANCE
    rsi_ok = RSI_LOW <= latest_rsi <= RSI_HIGH
    volume_declining = volume_ratio(volume, recent_window=SHORT_TERM_WINDOW, baseline_window=MID_TERM_WINDOW) < 1

    return long_term_up and pullback and rsi_ok and volume_declining
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `pytest pipeline/tests/test_screener.py -v`
Expected: 6개 테스트 모두 PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/screener.py pipeline/tests/test_screener.py
git commit -m "Add pullback (눌림목) screening filter"
```

---

### Task 7: universe_kr.py — 한국 종목 유니버스

**Files:**
- Create: `pipeline/src/universe_kr.py`
- Test: `pipeline/tests/test_universe_kr.py`

**Interfaces:**
- Consumes: `FinanceDataReader.StockListing("KRX")`, `FinanceDataReader.StockListing("KRX-DESC")`
- Produces: `get_kr_universe(min_market_cap: float) -> pd.DataFrame` — 컬럼: `ticker, name, sector, market_cap, meets_cap_threshold`

**참고 (실제 라이브러리 동작 확인됨):**
- `fdr.StockListing("KRX")` → 컬럼 `Code, Name, Market, ..., Marcap, ...`
- `fdr.StockListing("KRX-DESC")` → 컬럼 `Code, Name, Market, Sector, Industry, ...` (일부 종목은 `Sector`가 NaN)

- [ ] **Step 1: 실패하는 테스트 작성 (FinanceDataReader는 mock으로 대체)**

`pipeline/tests/test_universe_kr.py`:
```python
import pandas as pd
from unittest.mock import patch

from pipeline.src.universe_kr import get_kr_universe


def _fake_listing(market):
    if market == "KRX":
        return pd.DataFrame({
            "Code": ["005930", "000660", "999999"],
            "Name": ["Samsung", "SK Hynix", "Tiny Corp"],
            "Market": ["KOSPI", "KOSPI", "KOSDAQ"],
            "Marcap": [400_000_000_000_000, 350_000_000_000, 10_000_000_000],
        })
    if market == "KRX-DESC":
        return pd.DataFrame({
            "Code": ["005930", "000660", "999999"],
            "Name": ["Samsung", "SK Hynix", "Tiny Corp"],
            "Market": ["KOSPI", "KOSPI", "KOSDAQ"],
            "Sector": ["Electronics", None, "Misc"],
        })
    raise ValueError(f"unexpected market arg: {market}")


@patch("pipeline.src.universe_kr.fdr.StockListing", side_effect=_fake_listing)
def test_merges_listing_and_sector_with_cap_threshold(mock_listing):
    result = get_kr_universe(min_market_cap=300_000_000_000)
    result = result.set_index("ticker")

    assert result.loc["005930", "sector"] == "Electronics"
    assert result.loc["005930", "meets_cap_threshold"] is True
    assert result.loc["000660", "meets_cap_threshold"] is True
    assert result.loc["999999", "meets_cap_threshold"] is False
    assert pd.isna(result.loc["000660", "sector"])
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `pytest pipeline/tests/test_universe_kr.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.src.universe_kr'`

- [ ] **Step 3: 최소 구현 작성**

`pipeline/src/universe_kr.py`:
```python
from __future__ import annotations

import FinanceDataReader as fdr
import pandas as pd


def get_kr_universe(min_market_cap: float) -> pd.DataFrame:
    listing = fdr.StockListing("KRX")[["Code", "Name", "Market", "Marcap"]]
    desc = fdr.StockListing("KRX-DESC")[["Code", "Sector"]]

    universe = listing.merge(desc, on="Code", how="left")
    universe = universe.rename(columns={
        "Code": "ticker",
        "Name": "name",
        "Marcap": "market_cap",
        "Sector": "sector",
    })
    universe["meets_cap_threshold"] = universe["market_cap"] >= min_market_cap
    return universe[["ticker", "name", "sector", "market_cap", "meets_cap_threshold"]]
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `pytest pipeline/tests/test_universe_kr.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/universe_kr.py pipeline/tests/test_universe_kr.py
git commit -m "Add KR stock universe loader"
```

---

### Task 8: universe_us.py — 미국 종목 유니버스

**Files:**
- Create: `pipeline/src/universe_us.py`
- Test: `pipeline/tests/test_universe_us.py`

**Interfaces:**
- Consumes: `FinanceDataReader.StockListing("S&P500")`, `requests.get` (나스닥100 위키 표)
- Produces: `get_us_universe() -> pd.DataFrame` — 컬럼: `ticker, name, sector, index_membership`

**참고 (실제 동작 확인됨):**
- `fdr.StockListing("S&P500")` → 컬럼 `Symbol, Name, Sector, Industry`
- 나스닥100 구성종목은 FinanceDataReader에 없어서 위키백과 표를 직접 읽음. `requests.get(url, headers={"User-Agent": "Mozilla/5.0"})` 없이는 위키백과가 403을 반환하므로 User-Agent 헤더가 필수. 위키 페이지의 표 순서가 바뀔 수 있으므로 인덱스 대신 `"Ticker"`, `"Company"` 컬럼이 모두 있는 표를 찾아서 사용.
- 나스닥100 전용 종목(S&P500에 없는 종목)은 섹터 정보가 없어 `sector=None`이 되고, 이후 `sectors.leading_sectors`에서 자동으로 제외됨 (알려진 한계, MVP 범위에서는 허용)

- [ ] **Step 1: 실패하는 테스트 작성**

`pipeline/tests/test_universe_us.py`:
```python
import pandas as pd
from unittest.mock import patch

from pipeline.src.universe_us import get_us_universe

FAKE_SP500 = pd.DataFrame({
    "Symbol": ["AAPL", "MSFT"],
    "Name": ["Apple", "Microsoft"],
    "Sector": ["Information Technology", "Information Technology"],
    "Industry": ["Tech Hardware", "Software"],
})

FAKE_NASDAQ100_HTML = """
<html><body>
<table><tr><th>Other</th></tr><tr><td>irrelevant</td></tr></table>
<table>
<tr><th>Ticker</th><th>Company</th><th>ICB Industry</th></tr>
<tr><td>AAPL</td><td>Apple</td><td>Technology</td></tr>
<tr><td>PDD</td><td>PDD Holdings</td><td>Consumer Discretionary</td></tr>
</table>
</body></html>
"""


@patch("pipeline.src.universe_us.requests.get")
@patch("pipeline.src.universe_us.fdr.StockListing", return_value=FAKE_SP500)
def test_combines_sp500_and_nasdaq100_without_duplicates(mock_listing, mock_get):
    mock_get.return_value.text = FAKE_NASDAQ100_HTML

    result = get_us_universe().set_index("ticker")

    assert result.loc["AAPL", "index_membership"] == "S&P500"  # SP500 entry kept (first), not overwritten
    assert result.loc["AAPL", "sector"] == "Information Technology"
    assert result.loc["MSFT", "index_membership"] == "S&P500"
    assert result.loc["PDD", "index_membership"] == "NASDAQ100"
    assert pd.isna(result.loc["PDD", "sector"])
    assert len(result) == 3
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `pytest pipeline/tests/test_universe_us.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.src.universe_us'`

- [ ] **Step 3: 최소 구현 작성**

`pipeline/src/universe_us.py`:
```python
from __future__ import annotations

import io

import FinanceDataReader as fdr
import pandas as pd
import requests

NASDAQ100_WIKI_URL = "https://en.wikipedia.org/wiki/Nasdaq-100"


def _fetch_nasdaq100_table() -> pd.DataFrame:
    headers = {"User-Agent": "Mozilla/5.0"}
    html = requests.get(NASDAQ100_WIKI_URL, headers=headers, timeout=30).text
    tables = pd.read_html(io.StringIO(html))
    for table in tables:
        columns = [str(c) for c in table.columns]
        if "Ticker" in columns and "Company" in columns:
            return table[["Ticker", "Company"]].rename(columns={"Ticker": "ticker", "Company": "name"})
    raise ValueError("Nasdaq-100 constituent table not found on Wikipedia page")


def get_us_universe() -> pd.DataFrame:
    sp500 = fdr.StockListing("S&P500")[["Symbol", "Name", "Sector"]]
    sp500 = sp500.rename(columns={"Symbol": "ticker", "Name": "name"})
    sp500["index_membership"] = "S&P500"

    nasdaq100 = _fetch_nasdaq100_table()
    nasdaq100["sector"] = None
    nasdaq100["index_membership"] = "NASDAQ100"

    universe = pd.concat([sp500, nasdaq100], ignore_index=True)
    universe = universe.drop_duplicates(subset="ticker", keep="first")
    return universe[["ticker", "name", "sector", "index_membership"]]
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `pytest pipeline/tests/test_universe_us.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/universe_us.py pipeline/tests/test_universe_us.py
git commit -m "Add US stock universe loader (S&P500 + Nasdaq100)"
```

---

### Task 9: prices_kr.py — 한국 가격 데이터

**Files:**
- Create: `pipeline/src/prices_kr.py`
- Test: `pipeline/tests/test_prices_kr.py`

**Interfaces:**
- Consumes: `FinanceDataReader.DataReader`
- Produces:
  - `get_kospi_index_history(end: date, lookback_days: int) -> pd.Series`
  - `get_kr_stock_history(ticker: str, end: date, lookback_days: int) -> pd.DataFrame` (컬럼: `Open, High, Low, Close, Volume`)

**참고 (실제 동작 확인됨):** `fdr.DataReader("KS11", start, end)`가 KOSPI 지수, `fdr.DataReader("005930", start, end)`가 개별 종목 OHLCV를 반환 (컬럼: `Open, High, Low, Close, Volume, Change`).

- [ ] **Step 1: 실패하는 테스트 작성**

`pipeline/tests/test_prices_kr.py`:
```python
from datetime import date
from unittest.mock import patch

import pandas as pd

from pipeline.src.prices_kr import get_kospi_index_history, get_kr_stock_history

FAKE_OHLCV = pd.DataFrame({
    "Open": [100, 101],
    "High": [105, 106],
    "Low": [99, 100],
    "Close": [104, 105],
    "Volume": [1000, 1100],
    "Change": [0.01, 0.01],
}, index=pd.to_datetime(["2024-01-01", "2024-01-02"]))


@patch("pipeline.src.prices_kr.fdr.DataReader", return_value=FAKE_OHLCV)
def test_get_kospi_index_history_returns_close_series(mock_reader):
    result = get_kospi_index_history(end=date(2024, 1, 2), lookback_days=300)
    mock_reader.assert_called_once()
    assert mock_reader.call_args[0][0] == "KS11"
    assert list(result) == [104, 105]


@patch("pipeline.src.prices_kr.fdr.DataReader", return_value=FAKE_OHLCV)
def test_get_kr_stock_history_returns_ohlcv_columns(mock_reader):
    result = get_kr_stock_history("005930", end=date(2024, 1, 2), lookback_days=120)
    mock_reader.assert_called_once()
    assert mock_reader.call_args[0][0] == "005930"
    assert list(result.columns) == ["Open", "High", "Low", "Close", "Volume"]
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `pytest pipeline/tests/test_prices_kr.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.src.prices_kr'`

- [ ] **Step 3: 최소 구현 작성**

`pipeline/src/prices_kr.py`:
```python
from __future__ import annotations

from datetime import date, timedelta

import FinanceDataReader as fdr
import pandas as pd

KOSPI_INDEX_TICKER = "KS11"


def get_kospi_index_history(end: date, lookback_days: int) -> pd.Series:
    start = end - timedelta(days=lookback_days)
    df = fdr.DataReader(KOSPI_INDEX_TICKER, start.isoformat(), end.isoformat())
    return df["Close"]


def get_kr_stock_history(ticker: str, end: date, lookback_days: int) -> pd.DataFrame:
    start = end - timedelta(days=lookback_days)
    df = fdr.DataReader(ticker, start.isoformat(), end.isoformat())
    return df[["Open", "High", "Low", "Close", "Volume"]]
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `pytest pipeline/tests/test_prices_kr.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/prices_kr.py pipeline/tests/test_prices_kr.py
git commit -m "Add KR price history fetchers"
```

---

### Task 10: prices_us.py — 미국 가격 데이터 및 시가총액

**Files:**
- Create: `pipeline/src/prices_us.py`
- Test: `pipeline/tests/test_prices_us.py`

**Interfaces:**
- Consumes: `yfinance.download`, `yfinance.Ticker`
- Produces:
  - `get_sp500_index_history(end: date, lookback_days: int) -> pd.Series`
  - `get_us_stock_histories(tickers: list[str], end: date, lookback_days: int) -> dict[str, pd.DataFrame]`
  - `get_us_market_caps(tickers: list[str]) -> dict[str, float]`

**참고 (실제 동작 확인됨):**
- `yf.download("^GSPC", start=..., end=...)` (단일 티커, `group_by` 미지정) → 컬럼이 `(field, ticker)` 형태의 MultiIndex가 됨. `df["Close"]["^GSPC"]`로 Series 추출.
- `yf.download([...], start=..., end=..., group_by="ticker")` (복수 티커) → 컬럼이 `(ticker, field)` 형태. `raw[ticker][["Open","High","Low","Close","Volume"]]`로 개별 종목 추출.
- `yf.Ticker(ticker).fast_info["marketCap"]`로 시가총액 조회 (종목당 약 0.5~0.6초 소요, 600개 기준 약 5~6분 — 일 1회 배치이므로 허용 가능)

- [ ] **Step 1: 실패하는 테스트 작성**

`pipeline/tests/test_prices_us.py`:
```python
from datetime import date
from unittest.mock import MagicMock, patch

import pandas as pd

from pipeline.src.prices_us import (
    get_sp500_index_history,
    get_us_market_caps,
    get_us_stock_histories,
)


def _fake_single_ticker_download(*args, **kwargs):
    columns = pd.MultiIndex.from_tuples([
        ("Close", "^GSPC"), ("Open", "^GSPC"), ("High", "^GSPC"), ("Low", "^GSPC"), ("Volume", "^GSPC"),
    ])
    return pd.DataFrame(
        [[104, 100, 105, 99, 1000], [105, 101, 106, 100, 1100]],
        columns=columns,
        index=pd.to_datetime(["2024-01-01", "2024-01-02"]),
    )


def _fake_multi_ticker_download(*args, **kwargs):
    columns = pd.MultiIndex.from_tuples([
        ("AAPL", "Open"), ("AAPL", "High"), ("AAPL", "Low"), ("AAPL", "Close"), ("AAPL", "Volume"),
        ("MSFT", "Open"), ("MSFT", "High"), ("MSFT", "Low"), ("MSFT", "Close"), ("MSFT", "Volume"),
    ])
    return pd.DataFrame(
        [[100, 105, 99, 104, 1000, 200, 205, 199, 204, 2000],
         [101, 106, 100, 105, 1100, 201, 206, 200, 205, 2100]],
        columns=columns,
        index=pd.to_datetime(["2024-01-01", "2024-01-02"]),
    )


@patch("pipeline.src.prices_us.yf.download", side_effect=_fake_single_ticker_download)
def test_get_sp500_index_history_returns_close_series(mock_download):
    result = get_sp500_index_history(end=date(2024, 1, 2), lookback_days=400)
    assert list(result) == [104, 105]


@patch("pipeline.src.prices_us.yf.download", side_effect=_fake_multi_ticker_download)
def test_get_us_stock_histories_returns_per_ticker_frames(mock_download):
    result = get_us_stock_histories(["AAPL", "MSFT"], end=date(2024, 1, 2), lookback_days=200)
    assert set(result.keys()) == {"AAPL", "MSFT"}
    assert list(result["AAPL"].columns) == ["Open", "High", "Low", "Close", "Volume"]
    assert result["AAPL"]["Close"].iloc[-1] == 105


@patch("pipeline.src.prices_us.yf.Ticker")
def test_get_us_market_caps_returns_value_per_ticker(mock_ticker_cls):
    fake_ticker = MagicMock()
    fake_ticker.fast_info = {"marketCap": 123.0}
    mock_ticker_cls.return_value = fake_ticker

    result = get_us_market_caps(["AAPL"])
    assert result == {"AAPL": 123.0}


@patch("pipeline.src.prices_us.yf.Ticker")
def test_get_us_market_caps_defaults_to_zero_on_error(mock_ticker_cls):
    mock_ticker_cls.side_effect = RuntimeError("network error")
    result = get_us_market_caps(["BROKEN"])
    assert result == {"BROKEN": 0.0}
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `pytest pipeline/tests/test_prices_us.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.src.prices_us'`

- [ ] **Step 3: 최소 구현 작성**

`pipeline/src/prices_us.py`:
```python
from __future__ import annotations

from datetime import date, timedelta

import pandas as pd
import yfinance as yf

SP500_INDEX_TICKER = "^GSPC"


def get_sp500_index_history(end: date, lookback_days: int) -> pd.Series:
    start = end - timedelta(days=lookback_days)
    df = yf.download(SP500_INDEX_TICKER, start=start.isoformat(), end=end.isoformat(), progress=False)
    return df["Close"][SP500_INDEX_TICKER]


def get_us_stock_histories(tickers: list[str], end: date, lookback_days: int) -> dict[str, pd.DataFrame]:
    start = end - timedelta(days=lookback_days)
    raw = yf.download(
        tickers, start=start.isoformat(), end=end.isoformat(), progress=False, group_by="ticker",
    )
    histories: dict[str, pd.DataFrame] = {}
    for ticker in tickers:
        histories[ticker] = raw[ticker][["Open", "High", "Low", "Close", "Volume"]].dropna()
    return histories


def get_us_market_caps(tickers: list[str]) -> dict[str, float]:
    caps: dict[str, float] = {}
    for ticker in tickers:
        try:
            caps[ticker] = float(yf.Ticker(ticker).fast_info["marketCap"])
        except Exception:
            caps[ticker] = 0.0
    return caps
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `pytest pipeline/tests/test_prices_us.py -v`
Expected: 4개 테스트 모두 PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/prices_us.py pipeline/tests/test_prices_us.py
git commit -m "Add US price history and market cap fetchers"
```

---

### Task 11: db.py — Supabase 저장

**Files:**
- Create: `pipeline/src/db.py`
- Test: `pipeline/tests/test_db.py`

**Interfaces:**
- Consumes: `supabase.create_client`, `supabase.Client`
- Produces:
  - `PipelineResult` 데이터클래스 (필드: `date, market, regime, leading_sectors, screened_stocks, price_history`)
  - `ScreenerDB.from_env() -> ScreenerDB`
  - `ScreenerDB.save_pipeline_result(result: PipelineResult) -> None`

- [ ] **Step 1: 실패하는 테스트 작성**

`pipeline/tests/test_db.py`:
```python
from unittest.mock import MagicMock

from pipeline.src.db import PipelineResult, ScreenerDB


def test_save_pipeline_result_writes_all_tables():
    client = MagicMock()
    db = ScreenerDB(client)

    result = PipelineResult(
        date="2024-01-02",
        market="KR",
        regime="bull",
        leading_sectors=["Semiconductors", "Auto"],
        screened_stocks=[{"ticker": "005930", "name": "Samsung", "sector": "Semiconductors",
                           "close": 70000, "market_cap": 4e14, "rsi": 45.0}],
        price_history=[{"ticker": "005930", "market": "KR", "date": "2024-01-02",
                         "open": 100, "high": 105, "low": 99, "close": 104, "volume": 1000}],
    )

    db.save_pipeline_result(result)

    client.table.assert_any_call("market_regime")
    client.table.assert_any_call("leading_sectors")
    client.table.assert_any_call("screened_stocks")
    client.table.assert_any_call("stock_price_history")

    regime_call = client.table.return_value.upsert.call_args_list[0]
    assert regime_call.args[0] == {"date": "2024-01-02", "market": "KR", "regime": "bull"}


def test_save_pipeline_result_skips_empty_sector_and_stock_lists():
    client = MagicMock()
    db = ScreenerDB(client)

    result = PipelineResult(
        date="2024-01-02", market="KR", regime="bear",
        leading_sectors=[], screened_stocks=[], price_history=[],
    )

    db.save_pipeline_result(result)

    table_calls = [call.args[0] for call in client.table.call_args_list]
    assert table_calls == ["market_regime"]
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `pytest pipeline/tests/test_db.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.src.db'`

- [ ] **Step 3: 최소 구현 작성**

`pipeline/src/db.py`:
```python
from __future__ import annotations

import os
from dataclasses import dataclass, field

from supabase import Client, create_client


@dataclass
class PipelineResult:
    date: str
    market: str
    regime: str
    leading_sectors: list[str] = field(default_factory=list)
    screened_stocks: list[dict] = field(default_factory=list)
    price_history: list[dict] = field(default_factory=list)


class ScreenerDB:
    def __init__(self, client: Client):
        self.client = client

    @classmethod
    def from_env(cls) -> "ScreenerDB":
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_KEY"]
        return cls(create_client(url, key))

    def save_pipeline_result(self, result: PipelineResult) -> None:
        self.client.table("market_regime").upsert({
            "date": result.date,
            "market": result.market,
            "regime": result.regime,
        }).execute()

        if result.leading_sectors:
            rows = [
                {"date": result.date, "market": result.market, "sector": sector, "rank": rank + 1}
                for rank, sector in enumerate(result.leading_sectors)
            ]
            self.client.table("leading_sectors").upsert(rows).execute()

        if result.screened_stocks:
            rows = [
                {"date": result.date, "market": result.market, **stock}
                for stock in result.screened_stocks
            ]
            self.client.table("screened_stocks").upsert(rows).execute()

        if result.price_history:
            self.client.table("stock_price_history").upsert(result.price_history).execute()
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `pytest pipeline/tests/test_db.py -v`
Expected: 2개 테스트 모두 PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/db.py pipeline/tests/test_db.py
git commit -m "Add Supabase writer for pipeline results"
```

---

### Task 12: pipeline.py — 시장별 오케스트레이션

**Files:**
- Create: `pipeline/src/pipeline.py`
- Test: `pipeline/tests/test_pipeline.py`

**Interfaces:**
- Consumes: `universe_kr.get_kr_universe`, `universe_us.get_us_universe`, `prices_kr.*`, `prices_us.*`, `market_regime.determine_market_regime`, `sectors.leading_sectors`, `screener.passes_pullback_filter`, `indicators.rsi`
- Produces:
  - `ScreenedStock` 데이터클래스 (필드: `ticker, name, sector, close, market_cap, rsi`)
  - `MarketPipelineResult` 데이터클래스 (필드: `market, regime, leading_sectors, screened_stocks, price_history`)
  - `run_kr_pipeline(today: date) -> MarketPipelineResult`
  - `run_us_pipeline(today: date) -> MarketPipelineResult`

- [ ] **Step 1: 실패하는 테스트 작성 (하위 모듈은 모두 monkeypatch로 대체)**

`pipeline/tests/test_pipeline.py`:
```python
from datetime import date

import numpy as np
import pandas as pd
import pytest

from pipeline.src import pipeline as pl


def _passing_history(n_up=95, drop_pct=0.030) -> pd.DataFrame:
    base = 100 + np.linspace(0, 40, n_up)
    peak = base[-1]
    total_drop = peak * drop_pct
    pullback = [peak - total_drop * f for f in (0.3, 0.55, 0.75, 0.9, 1.0)]
    close = list(base) + pullback
    volume = [1_000_000.0] * n_up + [600_000, 550_000, 500_000, 480_000, 450_000]
    return pd.DataFrame({
        "Open": close, "High": close, "Low": close, "Close": close, "Volume": volume,
    })


def _flat_history(n=30) -> pd.DataFrame:
    close = [100.0] * n
    volume = [500_000.0] * n
    return pd.DataFrame({"Open": close, "High": close, "Low": close, "Close": close, "Volume": volume})


@pytest.fixture
def kr_universe_df():
    return pd.DataFrame([
        {"ticker": "AAA", "name": "Stock AAA", "sector": "Semiconductors",
         "market_cap": 4e14, "meets_cap_threshold": True},
        {"ticker": "BBB", "name": "Stock BBB", "sector": "Semiconductors",
         "market_cap": 1e9, "meets_cap_threshold": False},
    ])


def test_run_kr_pipeline_screens_only_leading_sector_and_cap_qualified_stocks(monkeypatch, kr_universe_df):
    monkeypatch.setattr(pl.universe_kr, "get_kr_universe", lambda min_market_cap: kr_universe_df)
    monkeypatch.setattr(
        pl.prices_kr, "get_kospi_index_history",
        lambda today, lookback_days: pd.Series(100 + np.linspace(0, 100, 250)),
    )

    def fake_history(ticker, today, lookback_days):
        return _passing_history() if lookback_days == pl.FULL_HISTORY_LOOKBACK_DAYS else _flat_history()

    monkeypatch.setattr(pl.prices_kr, "get_kr_stock_history", fake_history)
    monkeypatch.setattr(pl.sectors, "leading_sectors", lambda df, top_n: ["Semiconductors"])

    result = pl.run_kr_pipeline(today=date(2024, 1, 2))

    assert result.market == "KR"
    assert result.regime == "bull"
    assert result.leading_sectors == ["Semiconductors"]
    tickers = [s.ticker for s in result.screened_stocks]
    assert tickers == ["AAA"]  # BBB excluded by market cap threshold
    assert "AAA" in result.price_history


def test_run_kr_pipeline_returns_no_stocks_when_no_leading_sectors(monkeypatch, kr_universe_df):
    monkeypatch.setattr(pl.universe_kr, "get_kr_universe", lambda min_market_cap: kr_universe_df)
    monkeypatch.setattr(
        pl.prices_kr, "get_kospi_index_history",
        lambda today, lookback_days: pd.Series(100 - np.linspace(0, 50, 250)),
    )
    monkeypatch.setattr(pl.prices_kr, "get_kr_stock_history", lambda *a, **k: _flat_history())
    monkeypatch.setattr(pl.sectors, "leading_sectors", lambda df, top_n: [])

    result = pl.run_kr_pipeline(today=date(2024, 1, 2))

    assert result.regime == "bear"
    assert result.leading_sectors == []
    assert result.screened_stocks == []
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `pytest pipeline/tests/test_pipeline.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.src.pipeline'`

- [ ] **Step 3: 최소 구현 작성**

`pipeline/src/pipeline.py`:
```python
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Callable

import pandas as pd

from . import prices_kr, prices_us, sectors, universe_kr, universe_us
from .indicators import rsi
from .market_regime import determine_market_regime
from .screener import passes_pullback_filter

SECTOR_DETECTION_LOOKBACK_DAYS = 45
FULL_HISTORY_LOOKBACK_DAYS = 200
INDEX_LOOKBACK_DAYS = 400
KR_MIN_MARKET_CAP = 300_000_000_000
US_MIN_MARKET_CAP = 200_000_000


@dataclass
class ScreenedStock:
    ticker: str
    name: str
    sector: str
    close: float
    market_cap: float
    rsi: float


@dataclass
class MarketPipelineResult:
    market: str
    regime: str
    leading_sectors: list[str] = field(default_factory=list)
    screened_stocks: list[ScreenedStock] = field(default_factory=list)
    price_history: dict[str, pd.DataFrame] = field(default_factory=dict)


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
    candidates: pd.DataFrame, fetch_full_history: Callable[[str], pd.DataFrame],
) -> tuple[list[ScreenedStock], dict[str, pd.DataFrame]]:
    screened: list[ScreenedStock] = []
    price_history: dict[str, pd.DataFrame] = {}
    for _, row in candidates.iterrows():
        ticker = row["ticker"]
        hist = fetch_full_history(ticker)
        if hist.empty or not passes_pullback_filter(hist["Close"], hist["Volume"]):
            continue
        screened.append(ScreenedStock(
            ticker=ticker,
            name=row["name"],
            sector=row["sector"],
            close=float(hist["Close"].iloc[-1]),
            market_cap=float(row["market_cap"]),
            rsi=float(rsi(hist["Close"]).iloc[-1]),
        ))
        price_history[ticker] = hist.tail(120)
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
    top_sectors = sectors.leading_sectors(sector_df, top_n=3) if not sector_df.empty else []

    candidates = universe[universe["sector"].isin(top_sectors) & universe["meets_cap_threshold"]]
    screened, price_history = _screen_candidates(
        candidates, lambda t: prices_kr.get_kr_stock_history(t, today, FULL_HISTORY_LOOKBACK_DAYS),
    )

    return MarketPipelineResult(
        market="KR", regime=regime, leading_sectors=top_sectors,
        screened_stocks=screened, price_history=price_history,
    )


def run_us_pipeline(today: date) -> MarketPipelineResult:
    universe = universe_us.get_us_universe()
    market_caps = prices_us.get_us_market_caps(universe["ticker"].tolist())
    universe = universe.copy()
    universe["market_cap"] = universe["ticker"].map(market_caps).fillna(0.0)
    universe["meets_cap_threshold"] = universe["market_cap"] >= US_MIN_MARKET_CAP

    index_close = prices_us.get_sp500_index_history(today, INDEX_LOOKBACK_DAYS)
    regime = determine_market_regime(index_close)

    recent_histories = prices_us.get_us_stock_histories(
        universe["ticker"].tolist(), today, SECTOR_DETECTION_LOOKBACK_DAYS,
    )
    sector_df = _build_sector_frame(universe, recent_histories)
    top_sectors = sectors.leading_sectors(sector_df, top_n=3) if not sector_df.empty else []

    candidates = universe[universe["sector"].isin(top_sectors) & universe["meets_cap_threshold"]]
    full_histories = prices_us.get_us_stock_histories(
        candidates["ticker"].tolist(), today, FULL_HISTORY_LOOKBACK_DAYS,
    )
    screened, price_history = _screen_candidates(candidates, lambda t: full_histories[t])

    return MarketPipelineResult(
        market="US", regime=regime, leading_sectors=top_sectors,
        screened_stocks=screened, price_history=price_history,
    )
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `pytest pipeline/tests/test_pipeline.py -v`
Expected: 2개 테스트 모두 PASS

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/pipeline.py pipeline/tests/test_pipeline.py
git commit -m "Add per-market pipeline orchestration"
```

---

### Task 13: main.py — 엔트리포인트

**Files:**
- Create: `pipeline/src/main.py`
- Test: `pipeline/tests/test_main.py`

**Interfaces:**
- Consumes: `pipeline.run_kr_pipeline`, `pipeline.run_us_pipeline`, `db.ScreenerDB`, `db.PipelineResult`
- Produces: `main() -> None` (스크립트 진입점)

- [ ] **Step 1: 실패하는 테스트 작성**

`pipeline/tests/test_main.py`:
```python
from datetime import date
from unittest.mock import MagicMock

import pandas as pd

from pipeline.src import main as main_module
from pipeline.src.pipeline import MarketPipelineResult, ScreenedStock


def test_main_saves_kr_and_us_results(monkeypatch):
    kr_result = MarketPipelineResult(
        market="KR", regime="bull", leading_sectors=["Semiconductors"],
        screened_stocks=[ScreenedStock(ticker="005930", name="Samsung", sector="Semiconductors",
                                        close=70000.0, market_cap=4e14, rsi=45.0)],
        price_history={"005930": pd.DataFrame(
            {"Open": [100], "High": [105], "Low": [99], "Close": [104], "Volume": [1000]},
            index=pd.to_datetime(["2024-01-02"]),
        )},
    )
    us_result = MarketPipelineResult(market="US", regime="bear")

    monkeypatch.setattr(main_module, "_today_kst", lambda: date(2024, 1, 2))
    monkeypatch.setattr(main_module, "run_kr_pipeline", lambda today: kr_result)
    monkeypatch.setattr(main_module, "run_us_pipeline", lambda today: us_result)
    monkeypatch.setattr(main_module, "load_dotenv", lambda: None)

    fake_db = MagicMock()
    monkeypatch.setattr(main_module.ScreenerDB, "from_env", classmethod(lambda cls: fake_db))

    main_module.main()

    assert fake_db.save_pipeline_result.call_count == 2
    first_call_result = fake_db.save_pipeline_result.call_args_list[0].args[0]
    assert first_call_result.market == "KR"
    assert first_call_result.date == "2024-01-02"
    assert first_call_result.screened_stocks[0]["ticker"] == "005930"
    assert first_call_result.price_history[0]["ticker"] == "005930"
    assert first_call_result.price_history[0]["close"] == 104.0
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `pytest pipeline/tests/test_main.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.src.main'`

- [ ] **Step 3: 최소 구현 작성**

`pipeline/src/main.py`:
```python
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv

from .db import PipelineResult, ScreenerDB
from .pipeline import MarketPipelineResult, run_kr_pipeline, run_us_pipeline

KST = timezone(timedelta(hours=9))


def _today_kst() -> date:
    return datetime.now(KST).date()


def _to_db_result(result: MarketPipelineResult, today: date) -> PipelineResult:
    screened_rows = [
        {
            "ticker": s.ticker, "name": s.name, "sector": s.sector,
            "close": s.close, "market_cap": s.market_cap, "rsi": s.rsi,
        }
        for s in result.screened_stocks
    ]

    history_rows = []
    for ticker, hist in result.price_history.items():
        for idx, row in hist.iterrows():
            history_rows.append({
                "ticker": ticker,
                "market": result.market,
                "date": idx.date().isoformat() if hasattr(idx, "date") else str(idx),
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"]),
                "volume": int(row["Volume"]),
            })

    return PipelineResult(
        date=today.isoformat(),
        market=result.market,
        regime=result.regime,
        leading_sectors=result.leading_sectors,
        screened_stocks=screened_rows,
        price_history=history_rows,
    )


def main() -> None:
    load_dotenv()
    today = _today_kst()
    db = ScreenerDB.from_env()
    for result in (run_kr_pipeline(today), run_us_pipeline(today)):
        db.save_pipeline_result(_to_db_result(result, today))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `pytest pipeline/tests/test_main.py -v`
Expected: PASS

- [ ] **Step 5: 전체 테스트 스위트 실행**

Run: `pytest pipeline/tests -v`
Expected: 지금까지 작성된 모든 테스트 PASS (Task 3~13 누적)

- [ ] **Step 6: Commit**

```bash
git add pipeline/src/main.py pipeline/tests/test_main.py
git commit -m "Add pipeline entrypoint wiring KR/US runs to Supabase"
```

---

### Task 14: GitHub Actions 일일 스케줄

**Files:**
- Create: `.github/workflows/daily-pipeline.yml`

**Interfaces:**
- Consumes: `pipeline/requirements.txt`, `pipeline/src/main.py`, GitHub repository secrets `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`

- [ ] **Step 1: 워크플로우 파일 작성**

`.github/workflows/daily-pipeline.yml`:
```yaml
name: Daily Screener Pipeline

on:
  schedule:
    - cron: "30 23 * * *"  # 08:30 KST (UTC+9), next calendar day in UTC
  workflow_dispatch: {}

jobs:
  run-pipeline:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Install dependencies
        run: pip install -r pipeline/requirements.txt

      - name: Run daily screener pipeline
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
        run: python -m pipeline.src.main
```

- [ ] **Step 2: 사용자에게 GitHub 리포지토리 Secrets 등록 요청**

(사람이 직접 해야 하는 단계 — Settings → Secrets and variables → Actions에서 `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` 등록)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/daily-pipeline.yml
git commit -m "Add daily GitHub Actions schedule for pipeline"
```

- [ ] **Step 4: 수동 실행으로 검증 (GitHub에 push한 뒤)**

GitHub 리포지토리 Actions 탭 → "Daily Screener Pipeline" → "Run workflow" (workflow_dispatch)로 수동 실행해서 실제 Supabase 프로젝트에 데이터가 쌓이는지 확인. Supabase 대시보드의 Table Editor에서 `market_regime`, `leading_sectors`, `screened_stocks`, `stock_price_history` 테이블에 오늘 날짜 행이 생겼는지 확인.

---

## 완료 후 다음 단계

이 계획이 끝나면 Supabase에 매일 실제 스크리닝 결과가 쌓이게 된다. 다음은 프론트엔드(Next.js) 구현 계획을 별도로 작성해 이 데이터를 웹사이트로 보여주는 작업이다.
