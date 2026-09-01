# 알고리즘 레퍼런스

> 스크리닝·채점·리스크·성적 집계에 쓰는 모든 공식과 상수를 한곳에 모은 문서입니다.
> 알고리즘 관련 질문이나 작업이면 소스를 다시 다 읽기 전에 **이 파일부터** 볼 것.
> "알고리즘 문서 열어줘"라고 하면 이 파일을 보여줍니다.
>
> 여기 적힌 상수는 전부 실제 소스에서 그대로 옮긴 값입니다. 값을 바꿀 때는 반드시
> **소스와 이 문서를 같이** 고치세요 — 안 그러면 이 문서가 거짓말을 하게 됩니다.
> 각 절 끝의 "소스"가 원본이고, 이 문서는 그 요약본입니다.

## 지표 기초

KR/US 공용. Python(`pipeline/src/indicators.py`)과 TS(`frontend/lib/calculations.ts`)에
같은 정의가 이중으로 있다 — 둘 다 고치지 않으면 화면 숫자와 스크리닝 판정이 어긋난다.

- **SMA(n)**: 단순 이동평균, `rolling(n).mean()`.
- **RSI(14)**: Wilder's smoothing (SMA 시드 → SMMA). 단순 이동평균 RSI가 아니다 —
  다르게 구현하면 스크리너 판정과 화면 표시값이 어긋난다.
- **ATR(n)**: True Range(`max(high-low, |high-prevClose|, |low-prevClose|)`)의 단순평균.
  Wilder 스무딩이 아니라 **단순 평균**이다 (risk.ts `computeATR`, watchlist.py `_atr`).
- **volume_ratio**: 최근 `recent_window`일 평균 거래량 ÷ 그 직전 `baseline_window`일 평균.
- **is_trending_up(series, lookback)**: `series[-1] > series[-1-lookback]`.

소스: `pipeline/src/indicators.py`, `frontend/lib/calculations.ts`

## 눌림목 스크리닝 (pipeline/src/screener.py)

`evaluate_pullback()`이 9개(KR/US는 SMA200 게이트 포함 시 사실상 동일 조건)를
전부 평가해 **미달 조건 목록**을 반환한다(통과/탈락 이분법이 아님 — 전원 미달인 날도
"가장 근접한" 상위 후보를 보여주기 위해).

`frontend/lib/screenerCriteria.ts`의 `STOCK_CRITERIA_COUNT`도 이 9와 반드시 같아야 한다.
**과거 한때 9로 잘못 박혀 있었던 적이 있다**("급락 차단"이라는, 실제로는 구현된 적 없는
9번째 조건이 UI 안내 문구에만 있었음, 2026-08 아베크롬비 9/9 표시를 계기로 발견) —
그때는 8이 맞는 값이었다. 지금의 9는 그 사고와는 무관하게, 2026-09-01 **조정 과다**
조건(`CRITERION_PULLBACK_DEPTH`)을 실제로 추가하면서 늘어난 값이다. `StockCard.tsx`의
`totalCriteria - failed_criteria.length` 계산이 분모를 이 값으로 쓰므로, 실제
CRITERION_* 개수와 어긋나면 모든 종목이 그 차이만큼 "공짜로 통과"하거나 부당하게
깎인 것처럼 보인다 — 조건을 추가/제거할 때마다 반드시 같이 맞출 것.

| 조건 (failed_criteria 라벨) | 판정식 | 상수 |
|---|---|---|
| `200일선 아래` (US/KR 공통, `require_sma200=True`) | `close > SMA200` | — |
| `장기 추세 꺾임` | `is_trending_up(SMA60, lookback=5) and close > SMA60` | `LONG_TERM_WINDOW=60`, lookback `5` |
| `눌림 구간 밖` | `SMA20*(1-0.05) ≤ close ≤ SMA10` | `PULLBACK_LOWER_TOLERANCE=0.05` |
| `RSI 범위 밖` | `40 ≤ RSI14 ≤ 60` | `RSI_LOW=40`, `RSI_HIGH=60` |
| `RSI 하락 중` | `RSI14[-1] > RSI14[-1-3]` | `RSI_DIRECTION_LOOKBACK=3` |
| `거래량 미감소` | `volume_ratio(5일/20일) < 0.65` | `VOLUME_DECLINE_THRESHOLD=0.65` |
| `선행 상승 부족` | 최근 60거래일 수익률 ≥ +15% | `IMPULSE_LOOKBACK_DAYS=60`, `IMPULSE_MIN_GAIN=0.15` |
| `조정 과다` | 직전 상승폭(같은 60일 구간의 저→고) 대비 되돌림 `(high60-close)/(high60-low60) ≤ 0.5` | `MAX_PULLBACK_RETRACEMENT=0.5` (같은 `IMPULSE_LOOKBACK_DAYS` 구간 재사용) |
| `반등 미확인` | 50% 룰(『매매의 기술』): `close ≥ L + 0.5*(H-L)` AND `volume[-1] > 최근 20일 평균` AND `close > open` — H/L은 당일을 뺀 최근 20일 고가/저가(조정 시작점/저점의 근사) | `BOUNCE_LOOKBACK=20`, `BOUNCE_VOLUME_WINDOW=20` |

최소 데이터: `MIN_HISTORY_DAYS=85`봉 미만이면 평가 자체를 건너뜀(None, 랭킹 제외).

**랭킹**: 미달 조건 개수 오름차순 → 그 다음 `impulse_gain`(선행 상승률) 내림차순.
전 조건 통과가 `TOP_CANDIDATES=5`개 미만인 날은 근접 종목으로 채운다
(`pipeline/src/pipeline.py`의 `_screen_candidates`).

### 유니버스 게이트 (pipeline/src/pipeline.py)

- 시총 하한: KR `KR_MIN_MARKET_CAP=3,000억원`, US `US_MIN_MARKET_CAP=$20억`.
  **`main.py`의 종목발굴 유니버스(`kr_opp_mask`/`opp_mask`)도 같은 값을 씀** — 한쪽만
  바꾸면 눌림목 화면과 종목발굴 화면 기준이 갈라진다.
- 섹터 게이트: `주도 섹터 소속 OR 시총 ≥ 메가캡 기준`
  (KR `KR_MEGA_CAP=20조원`, US `US_MEGA_CAP=$2,000억`) — 초대형주는 자기 섹터
  모멘텀을 끌어내려 주도 섹터에서 스스로 빠지는 구조적 맹점이 있어 게이트 면제.
- 하락장(`regime='bear'`) 날은 `시장 하락장`을 모든 후보의 failed_criteria에 추가
  → `passed=False`로 저장(성적 집계·이력에서 제외되지만 화면 랭킹에는 뜸).
- US 눌림목 스크리너 대상은 `S&P500/NASDAQ100/S&P400/S&P600`만(Russell3000 단독 편입
  종목은 패턴 매칭 전용, 스크리너 대상 아님).

### 시장 레짐 (pipeline/src/market_regime.py)

`SMA50 > SMA200` → `bull`, 아니면(SMA200 미산출 포함) `bear`. 기준 지수는 KR=코스피, US=S&P500.

### 주도 섹터 (pipeline/src/sectors.py)

최근 `window=5`거래일 구간에서: 섹터별 평균 거래대금(종가×거래량) 내림차순 정렬 후,
그 구간 시작~끝 종가 모멘텀이 **양수인 섹터만** 후보로 남겨 상위 `top_n`개.
(거래대금 1위라도 모멘텀이 마이너스면 제외됨.)

## 손절·목표·손익비 (frontend/lib/risk.ts)

먼저 `trendStatus(bars)`로 틀(추세/횡보)을 가른다 — **`pipeline/src/screener.py`의
`long_term_up` 게이트와 동일 조건**(`SMA60` 상승 + `close > SMA60`, 창 `TREND_SMA_PERIOD=60`,
lookback `5`)이어야 스크리닝 결과와 화면 표시가 안 어긋난다.

- `uptrend` → **추세 틀**(`trendFrame`)
- `insufficient_data` → 계산 안 함(데이터 부족)
- 그 외(`below_sma60`/`sma60_falling`) → **횡보 틀**(`rangeFrame`)

### 추세 틀 (trendFrame)

1. 손절: `max(swingLow - 0.5*ATR, entry - 1.5*ATR)` — 최근 20봉 기준.
   `STOP_BUFFER_ATR_MULT=0.5`(스윙 저점 그대로 두면 손절 사냥 당함), `1.5*ATR`.
   손절 ≥ 진입가면 `stop_above_entry`로 계산 포기.
2. 목표(`targetBasis`로 근거를 구분해서 화면에 표시):
   - **`resistance`**: 최근 90봉(`RESISTANCE_LOOKBACK`) 안의 피벗 고점(좌우 3봉,
     `PIVOT_WINDOW`, prominence ≥ 3%) 중 보상이 `MIN_REWARD_R=1`R 이상인 것 중 최솟값.
   - **`period_high`**: 의미 있는 저항은 없지만 90봉 구간 고점 자체가 `entry+2R`보다 높음
     → 그 구간 고점.
   - **`default_2r`**: 위 둘 다 없음(신고가 코앞) → `entry + 2*risk`. **차트 근거가 아니라
     리스크 관리 규칙값** — 신고가 부근 종목의 손익비가 2.00으로 자주 뭉치는 건 버그가
     아니라 이 기본값이 반복 사용된 결과(카드에 그렇게 라벨 표시, PR #62).
   - 목표는 어떤 경로든 `entry + MAX_REWARD_R(4)*risk`를 넘지 않게 clamp.
3. `wayResistance`: 목표 못 미쳐 걸리는 피벗 — 목표를 대체하지 않고 "한 번 막힐 수 있음"만 표시.

### 횡보 틀 (rangeFrame, `targetBasis='range_high'`)

손절은 추세 틀과 동일한 스윙 저점 공식. 목표는 **최근 60봉(`RANGE_WINDOW`) 박스 상단**
고정(위쪽에 열린 목표를 만들지 않음 — 손익비가 실제보다 좋아 보이는 착시 방지).
박스 상단 ≤ 진입가면 `no_upside`로 계산 포기.

### 손익비 등급 (frontend/lib/riskGrade.ts)

| 틀 | good | fair | 미만 → poor |
|---|---|---|---|
| trend | ≥2.5 | ≥1.5 | |
| range | ≥2.0 | ≥1.5 | |

색은 등락색(빨강/파랑)과 겹치지 않게 **글자 진하기**로만 표현(`text-foreground` →
`text-secondary-foreground` → `text-muted-foreground`).

## 횡보·조정 채점 (frontend/lib/opportunityScore.ts ↔ pipeline/src/watchlist.py)

**참조 구현은 TS, 실제 실행은 Python 포팅.** 상수 하나도 따로 놀면 안 됨.
`pipeline/src/opportunities.py`가 `watchlist.evaluate_watch`를 그대로 재사용해
감시 종목/횡보·조정 탭 기준을 통일한다.

**진입 조건**: 3년 고점 대비 조정폭 `MIN_DRAWDOWN=20% ~ MAX_DRAWDOWN=60%`
(`in_band_tickers`가 이 밴드로 대상을 좁힘 — `fundamentals.py`도 이 함수를 그대로 재사용).

### 하드 필터 3종 (하나라도 실패하면 점수 계산 자체를 안 함)

1. **신저가 없음**: 최근 20거래일(`RECENT_LOW_WINDOW`) 최저가 ≥ 그 이전 52주
   (`YEAR_WINDOW=252`) 구간 최저가.
2. **박스권**: 최근 60거래일(`BOX_WINDOW`) `(고가-저가)/저가 ≤ 30%`(`MAX_BOX_RANGE`).
3. **유동성**: 최근 20일·직전 40일 거래량 평균이 둘 다 0 초과.

### 가중 점수 (통과 종목만, 하드필터와 별개로 "저점 높이기"는 사실상 필수)

| 요소 | 가중치 | 공식 |
|---|---|---|
| 매도 소진 | 0.30 | `clamp01(daysSinceLow / 120)` — 52주 저점 이후 경과일 |
| 변동성 수축(VCP) | 0.25 | `clamp01((1 - ATR20/ATR60) / 0.4)` |
| 저점 높이기 | 0.25 | `최근120일 저점 > 그 이전120일 저점` → 1 or 0 (필수에 가까움, `HIGHER_LOW_WINDOW=120`) |
| 거래량 소진 | 0.20 | 비율 `r=avg(vol20일)/avg(vol이전40일)`: `r<0.5`→`clamp01((r-0.2)/0.3)`, `0.5≤r≤0.8`→1.0, `r>0.8`→`clamp01((1.2-r)/0.4)` |

**보너스**(상한 1.0으로 clamp):
- 이평 정배열 `close>SMA5>SMA20>SMA60` → **+0.10**
- 거래량 트리거 `당일 거래량 ≥ 90일 평균×2` → **+0.10**

### 매수 등급 환산 (frontend/lib/buySignal.ts)

`higherLows`가 거짓이면 점수 무관 무조건 `watch`(관망).

| 등급 | 하한 |
|---|---|
| 적극 검토 (`strong`) | 점수 ≥ 0.8 (`STRONG_SCORE`) |
| 매수 검토 (`consider`) | 점수 ≥ 0.7 (`CONSIDER_SCORE`) |
| 관망 (`watch`) | 그 외, 또는 저점 높이기 미충족 |

## 매도 신호 (frontend/lib/exitSignal.ts)

진입일부터 하루씩 걸으며 **처음 걸린 조건**을 신호로 본다(며칠 연속 유지를 요구하면
신호가 늦어짐). **신호 시점 가격을 저장하지 않고 매번 재현**한다 — 사이트에 안 들어온
날의 신호를 놓치지 않고 기존 보유분에도 소급 적용하기 위함.

**★ 컨셉(`paper_trades.source`)에 따라 규칙이 갈린다.** 눌림목과 횡보·조정은 애초에 다른 것을
노리고 산 종목이라 같은 잣대로 팔면 한쪽이 망가진다. `findExitSignal`은 `source`를 필수 인자로
받고(안 넘기면 타입 에러) 아래 두 갈래 중 하나를 적용한다.

### 공통 — 가격이 실제로 닿은 것 (`HARD_REASONS`)

1. `stop`: 그날 저가 ≤ 손절가 (그 가격에 체결 가정)
2. `target`: 그날 고가 ≥ 목표가

### `pullback` (눌림목 — 단기 매매)

상승 추세 종목의 조정을 노린 것이라 추세가 꺾이면 나와야 한다. 정황 신호가 전부 유효하다.

3. `distribution`: **거래량 ≥ 최근 20일 평균 × 2** AND **음봉**(종가 < 시가) AND
   **종가 < 전일 봉의 50% 지점**`((prev.high+prev.low)/2)`
   — 『매매의 기술』 매도 1·2원칙 + 곰의 50% 룰. `VOLUME_SPIKE_MULT=2`, `VOLUME_AVG_WINDOW=20`.
   **봉에 `open`/`volume`이 없으면 판정을 건너뛴다** (주도 섹터 규칙과 같은 이유 — 데이터
   구멍을 매도 신호로 둔갑시키지 않는다)
4. `bear`: 그날 장세가 하락장
5. `sector`: 그날 주도 섹터에 자기 섹터가 없음(그날 주도섹터 데이터 자체가 없으면 판정 보류)
6. `trend`: 종가 < SMA60 (`TREND_SMA_PERIOD`, risk.ts와 동일 정의)

### `opportunity` (횡보·조정 — 저점 매수 후 장기 보유)

**정황 신호를 쓰지 않는다.** 이 종목들은 3년 고점 대비 20~60% 빠진 것이라 **구조상 60일선
아래에 있고 주도 섹터도 아니다** — 눌림목 규칙을 그대로 걸면 **진입 다음 날 바로 매도 신호가
떴다**(테스트로 실증됨). 하락장은 오히려 매수 근거에 가깝다(『매매의 기술』 매수 제3원칙).

3. `breakdown`: 종가 < **진입 시점** 박스 하단(직전 `BASE_WINDOW=60`봉의 최저가)
   — 산 근거였던 바닥 자체가 무너진 경우. **기준선은 진입 시점에 고정**되어 보유가 길어져도
   따라 내려가지 않는다.

`breakdown`이 필요한 이유: `computeStopTarget`이 `stop_above_entry`/`no_upside`일 때
**stop·target을 둘 다 null로 준다.** 그 경우 매도 신호가 아예 없어지므로 최후의 방어선이 된다.

`BASE_WINDOW`는 `opportunityScore.ts`의 `BOX_WINDOW`와 같은 값이어야 진입 논거와 대칭이 된다.

## 스크리너 성적 집계 (frontend/lib/scorecard.ts)

**미청산 편향 문제**: 손절(~1R)이 목표(보통 2R+)보다 훨씬 빨리 걸리므로 "청산된 것만"
평균 내면 기댓값이 구조적으로 음수 쪽으로 치우친다. → `MAX_HOLD_BARS=60`거래일(약 3개월)
지나면 그 시점 종가로 강제 청산해 결론(`timeout`)을 낸다. 그만큼 안 지난 건 `pending`으로
**집계에서 통째로 제외**(0으로 세지 않음).

`resolveTrade`: 한 봉에서 손절·목표 둘 다 닿으면 **손절 우선**(장중 순서를 모르므로
불리한 쪽 선택 — 성적을 부풀리지 않기 위함).

**손익분기 도달률**(`breakevenHitRate = 1/(1+avgRewardR)`): 목표가 2R이면 33.3%가
손익분기. 실제 `hitRate`(목표 도달 비율)가 이보다 높아야 우위가 있다는 뜻 —
**33%를 "넘기만 하면 이득"이 아니라 "목표 배수에 따른 손익분기선"이 다름**을 항상
같이 봐야 한다(사용자 질문 "승률 33%만 넘겨도 씨드가 불어나나" 답변 근거).

**기댓값(expectancyR)** = 판정 완료분 R 합계 / 판정 완료 건수. 결국 관건은
"목표 도달률(hitRate)이 손익분기(breakevenHitRate)를 얼마나 웃도는가"다.

`verdictOf`: 판정 완료(`resolved`) < 20건 → `insufficient`(표본 부족, 20건 미만은 운으로
뒤집히는 범위). 그 이상에서 `expectancyR ≤ 0`→`negative`, `<0.2`→`marginal`, 그 이상→`positive`.

`segmentBy`(장세·미달개수 등으로 쪼갠 하위 집계): 표본 `MIN_SEGMENT_SAMPLE=5`건 미만인
구간은 착시 방지를 위해 통째로 버림.

## 실적 판정 (frontend/lib/fundamentals.ts)

"주가는 빠지는데 실적도 같이 빠졌나(가치 함정) vs 실적은 멀쩡한데 주가만 빠졌나
(밸류에이션 조정)"를 가른다. 전년 대비 변화율 = `(latest-prior)/|prior|` (분모가
음수여도 부호가 안 뒤집히게 절댓값).

**이익 판정은 당기순이익이 아니라 영업이익 기준이다** (2026-09-01, 개선안 5번).
친절한 주식책 + 한눈에 보는 실전 재무제표가 같은 지적을 한다 — 당기순이익은
자산 매각 같은 일회성 항목을 포함해 "진짜 돈을 버는 능력"을 왜곡한다(한국전력
2015년: 본사 부지 매각으로 영업이익 11.3조인데 당기순이익 13.4조, 이듬해
7조원대로 급감). `primaryProfit()`이 `operating_income_latest/prior`가 둘 다
있으면 그걸 쓰고, 없으면(구 데이터·수집 실패) `net_income_*`으로 대체한다 —
어느 쪽을 썼는지는 `profitSource: 'operating' | 'net'`으로 남아 배지 라벨에
그대로 쓰인다.

| 판정 | 조건 |
|---|---|
| `loss` | 최신 회계연도 이익(영업이익 우선) < 0 |
| `deteriorating` | 매출 ≤ -20%(`REVENUE_DROP`) **그리고** 이익 ≤ -30%(`PROFIT_DROP`) |
| `resilient` | 매출 ≥ -5%(`REVENUE_FLAT`) **그리고** 이익 ≥ -10%(`PROFIT_FLAT`) |
| `mixed` | 위 두 경우에 안 걸리는 나머지(방향이 엇갈리거나 애매) |
| `unknown` | 데이터 없음 |

**일회성 손익 경보** (`oneTimeGainFlag`): `|net_income_latest - operating_income_latest| /
|operating_income_latest| > 0.3`(`ONE_TIME_GAIN_THRESHOLD`)이면 별도 배지("💡 일회성
손익 비중 큼")를 위 판정과 별개로 함께 표시한다 — 영업이익 데이터가 없으면(비교
기준이 없으므로) 경보를 내지 않는다.

## 장기 고점/하락 (frontend/lib/longTermContext.ts)

`stock_long_monthly`(10년) + 최근 3년 월봉을 월 단위로 병합(같은 달이 겹치면 최신
데이터 우선). 월봉 40개(≈3년4개월) 미만이면 "장기 맥락 없음"으로 주장하지 않음
(`hasLongHistory=false`).

`longTermDeclining`: 3년 고점(`high3y`)이 장기 고점의 `80%`(`LONG_DECLINE_RATIO`) 미만
→ 3년 창 안에서는 안 보이는 여러 해에 걸친 하락이 있었다는 뜻.

## 오늘의 추천 — Gold Standard 패턴 매칭 (pipeline/src/pattern_discovery.py)

룰 기반 복합 스코어(유사도 검색이 아니라 "Gold Standard 바닥 특성에 얼마나 맞는가").

**하드 필터** (하나라도 실패 시 탈락):
- 가격 `$0.50 ~ $50`(`MIN_PRICE`/`MAX_PRICE`)
- 52주 최고가 대비 하락률 ≥ `55%`(`MIN_DRAWDOWN`)
- 저점 갱신 중단 ≥ `15`거래일(`MIN_DAYS_SINCE_LOW`)
- 거래량 유지율(최근20일/직전40일) ≥ `0.70`(`MIN_VOL_RATIO`)
- 일평균 거래대금 ≥ `$300,000`(`MIN_DOLLAR_VOL`)

**복합 점수**(가중합, 상한 1.0):
- 하락률 `0.3 * min(1, (drawdown-0.55)/0.35)`
- 소진일수 `0.4 * min(1, (days-15)/45)`
- 거래량 `0.3 * min(1, max(0, (volRatio-1)/2))`
- 보너스: VCP(`ATR10/ATR50 ≤ 0.6`) **+0.10**, 이평정배열(`close>SMA5>SMA10>SMA20`) **+0.10**

`MIN_SCORE=0.40` 미만 드롭, 상위 `TOP_N=20`만 저장.
**주의**: 이 스코어러의 SMA/ATR 정의는 watchlist.py·opportunityScore.ts와 **기간이 다르다**
(SMA5/10/20, ATR10/50) — 횡보·조정 채점(SMA5/20/60, ATR20/60)과 섞어 생각하지 말 것.
서로 다른 화면(오늘의 추천 vs 횡보·조정)의 서로 다른 알고리즘이다.

## 동기화 지점 요약 (같이 안 고치면 화면이 갈라지는 것들)

| 쌍 | 어긋나면 생기는 문제 |
|---|---|
| `screener.py`(`long_term_up`) ↔ `risk.ts`(`trendStatus`) | 손익비 틀 판정이 스크리닝 결과와 안 맞음 |
| `opportunityScore.ts` ↔ `watchlist.py` | 감시 종목과 횡보·조정 탭 점수가 갈라짐 |
| `watchlist.py`의 `MIN/MAX_DRAWDOWN` ↔ `opportunities.py`의 `in_band_tickers` | 조정폭 밴드 기준이 갈라짐 (다만 `fundamentals.py`는 `in_band_tickers`를 그대로 재사용하므로 안전) |
| `pipeline.py`의 `KR_MIN_MARKET_CAP`/`US_MIN_MARKET_CAP` ↔ `main.py`의 `kr_opp_mask`/`opp_mask` | 눌림목 화면과 종목발굴 유니버스 시총 기준이 갈라짐 |
| `pipeline/src/indicators.py` ↔ `frontend/lib/calculations.ts` | RSI/SMA 계산이 어긋나 스크리닝 판정과 화면 표시 불일치 |
