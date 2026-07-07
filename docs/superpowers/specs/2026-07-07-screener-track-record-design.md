# 눌림목 스크리너 종합 성적표 (실제 매매 기준 백테스트)

작성일: 2026-07-07
상태: 설계 승인 완료

## 1. 목적

기존 `/history` 페이지는 과거 눌림목 추천의 +1일·+2일·+3일 종가 수익률만 행 단위로 보여준다.
"이 스크리너를 실제로 매매했다면 성적이 어땠나"를 알 수 없다. 이 기능은 각 추천을
**진입 → 손절 or 목표 도달까지 실제로 끌고 갔을 때의 결과**로 집계한 종합 성적표를
KR·US 시장별로 페이지 상단에 추가한다.

## 2. 범위

- **대상 테이블**: `screened_stocks` (눌림목 스크리너)만. Gold Standard 패턴 추천
  (`recommendation_history`, '오늘의 추천')은 제외.
- **집계 기간**: 최근 **90일** (기존 행 테이블의 30일과 별개 파라미터).
- **파이프라인/DB 변경 없음**: 기존 `getScreenedStockPerformance` / `getExitSignals`가
  이미 추천일 이전 150일 + 추천일 이후 전체 가격 바를 가져온다. walk-forward에 필요한
  데이터가 모두 손 안에 있어 **파이프라인 재실행이 필요 없다.**

## 3. 매매 규칙 (한 건의 트레이드 정의)

각 추천 1건을 하나의 가상 트레이드로 본다.

| 항목 | 규칙 |
|------|------|
| 진입가 | 추천일 종가 (`rec.close`) |
| 손절가 | `computeStopTarget(preBars, entry).stop` (ATR 기반) |
| 목표가 | `computeStopTarget(preBars, entry).target` (직전 pivot-high 저항) |
| 진입 시점 | 추천일 **다음 거래일부터** 미래 바를 순회 |
| 손절 | 어느 바든 `low ≤ 손절가` → 손절 청산, 해당 바가 청산일 |
| 목표 도달 | 어느 바든 `high ≥ 목표가` → 목표 청산, 해당 바가 청산일 |
| 동시 충족 | 같은 바에서 손절·목표 둘 다 닿으면 **손절 우선**(보수적) |
| 미청산 | 마지막 바까지 둘 다 안 닿음 → 보유중, 평가손익 = 최신 종가 |

이 walk-forward는 `getExitSignals`의 353–366행 로직과 동일하다. 신규 함수는 이 판정을
재사용하고, 그 위에 **중복 제거 + 집계**만 얹는다.

### 청산가 처리
- 목표 청산 트레이드의 청산가 = **목표가**(레벨에 체결됐다고 가정)
- 손절 청산 트레이드의 청산가 = **손절가**
- 실현 수익률(%) = `(청산가 - 진입가) / 진입가 × 100`

### 손절가·목표가가 null인 경우
`computeStopTarget`이 `stop` 또는 `target`을 `null`로 반환하면(데이터 부족 등) 손익비·
청산 판정이 불완전해진다. 해당 추천은 **집계에서 제외**한다(성적표 분모에 넣지 않음).

## 4. 중복 추천 처리 — 첫날 매수

같은 종목이 90일 안에 여러 날 추천될 수 있다. 규칙: **종목별로 창(window) 안에서 가장
먼저 추천된 날 1건만** 트레이드로 카운트한다("추천 첫날에 샀다면"). 이후 같은 종목의
재추천은 무시한다.

- `recs`는 `date` 내림차순으로 온다 → 종목별 마지막 매칭 항목이 가장 이른 날짜.
- 구현: `Map<ticker, rec>`에 순회하며 넣되, 더 이른 날짜로만 덮어써 최종적으로 종목당
  최초 추천 1건만 남긴다.

## 5. 집계 지표 (시장별)

dedup 후 유효 트레이드 집합에 대해:

| 지표 | 정의 |
|------|------|
| 목표 도달률 | 목표 청산 건수 / 전체 트레이드 |
| 손절률 | 손절 청산 건수 / 전체 트레이드 |
| 미청산률 | 보유중 건수 / 전체 트레이드 |
| 평균 수익률(청산 기준) | 청산된 트레이드(목표+손절)의 실현 수익률 평균 |
| 평균 보유일 | 청산된 트레이드의 진입~청산 거래일 수 평균 |
| 손익비 (R) | 청산된 트레이드의 R 평균. R = `(청산가 - 진입가) / (진입가 - 손절가)` |
| 전체 트레이드 수 | 분모 (dedup·null제외 후) |

- 비율의 분모 = 전체 트레이드(미청산 포함).
- 평균 수익률·평균 보유일·손익비의 분모 = **청산된 트레이드만**(미청산 제외). 아직
  결과가 확정되지 않은 보유중 건은 평균을 왜곡하므로 뺀다.
- 트레이드가 0건이면 "표본 없음" 안내 문구.

## 6. 구현

### 6.1 신규 쿼리 — `frontend/lib/queries.ts`

```
getScreenerTrackRecord(market: Market, days = 90): Promise<TrackRecord>
```

- `getExitSignals`와 동일한 데이터 페치(추천 조회 + 150일 확장 가격 조회 + priceMap 구성)를
  공유한다. 중복 페치 로직은 내부 헬퍼로 추출하거나 `getExitSignals`의 패턴을 그대로 따른다.
- 종목별 dedup → 첫날 1건.
- 각 트레이드에 walk-forward 판정(손절 우선) → status/청산가/보유일 산출.
- null stop/target 제외.
- 위 지표 집계 → `TrackRecord` 반환.
- `'use cache'` + `cacheLife('hours')` (기존 쿼리와 동일).

### 6.2 타입 — `frontend/lib/types.ts`

```ts
interface TrackRecord {
  market: Market
  totalTrades: number
  targetHitRate: number   // 0~1
  stoppedOutRate: number
  openRate: number
  avgReturnPct: number     // 청산 기준
  avgHoldingDays: number   // 청산 기준
  avgR: number             // 손익비
}
```

### 6.3 컴포넌트 — `frontend/components/TrackRecordCard.tsx`

- 서버에서 받은 `TrackRecord`를 카드로 렌더.
- 비율은 % 표기, 손익비는 `R`, 수익률은 부호·색상(양수 녹색/음수 빨강).
- `totalTrades === 0`이면 "표본 없음" 안내.
- 기존 `PerformanceTable` 위에 시장별로 배치.

### 6.4 페이지 — `frontend/app/history/page.tsx`

- `HistoryContent()`에서 KR·US 각각 `getScreenerTrackRecord(market, 90)` 호출(기존
  `getScreenedStockPerformance` 호출과 병렬).
- 각 시장 블록: `<TrackRecordCard>` (상단) → 기존 `<PerformanceTable>` (하단) 순.
- 헤더/서브타이틀에 "90일 종합 성적표 · 실제 손절/목표 도달 기준" 취지 문구 보강.

## 7. 검증

- 타입체크/린트/빌드 통과.
- 수기 검산: 특정 종목 1건을 골라 진입가·손절·목표·청산 바를 눈으로 대조.
- dedup 확인: 같은 종목 다중 추천이 1건으로만 잡히는지.
- null 제외 확인: stop/target null 종목이 분모에서 빠지는지.

## 8. 명시적 비목표 (YAGNI)

- 알림/푸시 없음(별도로 스킵 결정됨).
- 수수료·슬리피지 모델링 없음.
- 부분 익절·트레일링 스탑 없음(단일 손절/단일 목표).
- Gold Standard 패턴 추천 성적 집계 없음(이번 범위 밖).
- 파이프라인/DB 스키마 변경 없음.
