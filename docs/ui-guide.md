# UI 레퍼런스

> 디자인 토큰·컴포넌트 관례·페이지 구조 패턴을 한곳에 모은 문서입니다.
> UI/디자인 관련 질문이나 작업이면 `globals.css`나 컴포넌트를 하나하나 다시 훑기 전에
> **이 파일부터** 볼 것. "UI 문서 열어줘"라고 하면 이 파일을 보여줍니다.
>
> 여기 없는 세부(정확한 클래스명 등)는 CLAUDE.md의 파일 표에서 실제 컴포넌트를
> 찾아 확인하세요. 이 문서는 "패턴과 이유"를, CLAUDE.md는 "어디에 뭐가 있는지"를 담당합니다.

## 디자인 토큰 (frontend/app/globals.css)

토스증권 팔레트. **카드마다 색을 직접 고르지 말고 아래 토큰을 쓸 것.**

| 토큰 | 라이트 | 다크 | 용도 |
|---|---|---|---|
| `--background` | `#F2F4F6`(body는 white card 위에 얹힘, 실제 배경은 `--background:#ffffff`) | `#131417` | 페이지 배경 |
| `--foreground` | `#191F28` | `#ECEFF3` | 기본 텍스트 |
| `--card` | `#FFFFFF` | `#1C1D22` | 카드 배경 |
| `--primary` | `#3182F6` | `#4E93FF` | 브랜드 블루(버튼·링크·강조) |
| `--secondary` / `--muted` | `#F2F4F6` (동일값) | `#23252B` | 옅은 회색 배경 (pill 버튼 평상시 등) |
| `--secondary-foreground` | `#333D4B` | `#ECEFF3` | 회색 배경 위 텍스트(진함) |
| `--muted-foreground` | `#8B95A1` | `#A7AEB8` | 보조 텍스트(연함) |
| `--accent` | `#E8F3FF` | `#16243B` | 선택된 pill 배경(연한 블루) |
| `--accent-foreground` | `#1B64DA` | `#8FBDFF` | accent 배경 위 텍스트 |
| `--destructive` | `#F04452` | `#FF5C6A` | 에러/경고 |
| `--border` | `#E5E8EB` | `#2E3138` | 테두리, pill hover 배경 |
| `--up` | `#F04452`(빨강) | `#FF5C6A` | **상승** |
| `--down` | `#3182F6`(파랑) | `#4E93FF` | **하락** |

**등락 색은 한국 증권 관례**: 상승=빨강(`text-up`), 하락=파랑(`text-down`). 서양식(상승=초록)
절대 쓰지 말 것. 손익비 같은 "방향이 아닌 품질" 값은 등락색과 겹치면 등락률로 오독되므로
색조가 아니라 **글자 진하기**로 표현한다(`riskGrade.ts` 참고).

**반경**: `--radius: 0.875rem`(=14px)이 기준, `rounded-xl`은 그 ×1.4(≈20px). 카드는 항상
`rounded-xl`.

**폰트**: 본문은 Pretendard self-host(`--font-sans`, `app/pretendard.css`). 자릿수를 맞춰야
하는 표(등락률·가격 등)에만 `font-mono`(Geist Mono). 한글 자간은 `letter-spacing: -0.01em`
전역 적용(토스·카카오 계열 감각).

> ⚠️ `--font-sans`는 `:root`에 정의되고 `@theme inline`이 그걸 참조한다 — **순서를 바꾸면
> 순환 참조로 폰트가 죽는다.** `:root` 정의가 `@theme` 뒤에 오는 구조를 유지할 것.

## 카드 패턴

거의 모든 콘텐츠 블록은 이 조합:

```tsx
<section className="rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
```

이 정확한 shadow 값(이중 그림자: 얕은 것 + 넓게 퍼지는 것)이 토스 스타일의 "떠 있는" 느낌을
낸다. 임의로 `shadow-md` 등 Tailwind 기본 그림자로 바꾸지 말 것.

## 탭/네비게이션 버튼 (pill 패턴)

상단 네비(`app/NavLinks.tsx`, `app/layout.tsx`)는 **버튼처럼 보이는 pill**:

```tsx
className={`relative shrink-0 rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition-colors ${
  active
    ? 'bg-accent font-bold text-accent-foreground'
    : 'bg-secondary font-medium text-secondary-foreground hover:bg-border'
}`}
```

- **평상시에도 배경이 있어야** 버튼이라는 게 한눈에 보인다(텍스트만 덜렁 두지 말 것).
- 활성 탭만 `bg-accent`로 튀게, 나머지는 `bg-secondary` 균일 배경 + hover 시 `bg-border`.
- `LinkPendingSpinner`를 pill 안에 넣을 때는 **반드시 `absolute` 배치**로 폭 계산에서 뺄 것
  (아래 "스피너" 절 참고) — 안 그러면 텍스트가 중앙에서 왼쪽으로 밀린다.

> ⚠️ 현재 `app/discover/DiscoverTabs.tsx`(횡보·조정/저점 매집 후보/패턴검색 서브탭)는 밑줄
> 스타일(`border-b-2`)의 예전 탭 UI를 아직 쓴다 — 상단 네비와 스타일이 다르다는 걸
> 인지하고 작업할 것. 통일이 필요하면 사용자에게 먼저 확인.

## 스피너 3종 — 언제 뭘 쓰는지 (자주 헷갈리는 지점)

| 컴포넌트 | 담당 구간 | 특징 |
|---|---|---|
| `components/Spinner.tsx` | 공용 베이스 SVG | 다른 둘이 이걸 감싸 씀 |
| `components/LinkPendingSpinner.tsx` | 클릭 → 라우터 전환 사이의 **아주 짧은 틈** | `useLinkStatus()` 기반. 프리페치된 링크(사이트 내 대부분)는 이 틈이 없어 아예 안 뜬다. **`<Link>`의 자식으로만** 쓸 수 있음. 항상 렌더링하고 opacity만 토글(레이아웃 밀림 방지) — 기본은 인라인 배치(`ml-1.5 inline size-3`)라 텍스트 뒤에 붙지만, 버튼처럼 텍스트를 가운데 둬야 하면 `className` prop으로 `absolute` 배치를 넘겨 폭 계산에서 빼야 한다(안 그러면 안 보일 때도 폭을 차지해 텍스트가 왼쪽으로 밀림 — NavLinks 참고). |
| `components/LoadingFallback.tsx` | **실제 데이터 로딩**(Suspense fallback) | 클릭 이후 대부분의 대기 시간이 여기. `label` prop으로 문구 지정, `className`(기본 `py-16`)으로 카드 안에 넣을 때 패딩 축소(`py-8` 등). |

**절대 헷갈리지 말 것**: "로딩 중..."이라는 텍스트만 있고 스피너가 안 도는 건 대부분
`LoadingFallback`이 빠졌거나(Suspense fallback에 plain text만 있음) 스피너 없이 텍스트만
넣은 경우다. `LinkPendingSpinner`는 그 구간을 담당하지 않는다(PR #68→#69에서 실제로
이 착오가 있었음).

## Suspense / 페이지 구조 패턴

- 페이지 최상위 컴포넌트는 **비동기로 만들지 않는다**. 정적 셸(제목·설명·안내 카드 등
  캐시 필요 없는 내용)은 그 안에 그대로 두고, 화면별 동적 데이터 fetch는 별도 async
  컴포넌트로 분리해 **섹션마다 자기 `<Suspense>`**로 감싼다 — 한 섹션의 느린 쿼리가
  다른 섹션 렌더를 막지 않게 하기 위함(스트리밍 병렬화).
- `searchParams`처럼 캐시 불가능한 요청-시점 API는 **`<Suspense>` 안의 컴포넌트에서만**
  await할 것 — 페이지 최상위(Suspense 밖)에서 await하면 Cache Components 빌드가
  "Uncached data accessed outside of Suspense"로 막는다.
- 개별 페이지가 아니라 진짜로 uncached/dynamic한 작업을 하는 async Server Component는
  `next/server`의 `connection()`을 호출해 그 서브트리를 정적 프리렌더에서 뺄 것
  (프로덕션 빌드가 더미 Supabase 키로 도는 걸 대비).
- Suspense `fallback`은 항상 `<LoadingFallback />`(위 표 참고). 예전에 쓰던
  `<p className="py-16 text-center text-muted-foreground">로딩 중...</p>` 패턴은 전부 교체됨 —
  새로 만들 때도 이 패턴으로 되돌아가지 말 것.

## 모바일 대응 (frontend/AGENTS.md 요약 — 원본이 더 자세함)

- 표를 만들면 폰에서 페이지 전체가 가로로 밀려 네비게이션까지 깨진다.
  `overflow-x-auto`만 걸면 부족 — **부모에 `min-w-0`이 없으면** 컨테이너가 내용에
  끌려 늘어난다.
- 열이 많은 표는 폰에서 카드로 갈아끼우는 게 답 (`md:hidden` / `hidden md:block`).
- 새 컴포넌트를 만들면 `/dev/preview`(프로덕션에서 `notFound()`로 막힘)에 케이스를
  추가할 것 — **"표본/값이 없을 때"와 "부호가 반대일 때"**를 반드시 포함(실제 데이터로는
  좀처럼 안 나와서 테스트·타입체크 통과한 채로 배포되기 쉬움).

### 로컬에서 눈으로 확인하는 절차 (DB 키 없이)

```bash
# 빌드·타입체크 — 더미 값이면 프리렌더까지 통과
SUPABASE_URL="https://dummy.supabase.co" SUPABASE_SERVICE_KEY="dummy" npx next build

# 렌더 확인 — /dev/preview에 픽스처로 채운 컴포넌트 미리보기
SUPABASE_URL="https://dummy.supabase.co" SUPABASE_SERVICE_KEY="dummy" npx next dev -p 3111
# playwright(전역 설치, /opt/pw-browsers/chromium)로 스크린샷.
# 폭 320(좁은 폰)/390(폰)/1000(데스크톱)은 항상 확인, 가로 스크롤 overflow-x가
# 0이 아니면 뭔가 잘린 것.
```

## 컴포넌트 → 역할 맵 (frontend/components/)

| 컴포넌트 | 역할 |
|---|---|
| `StockCard.tsx` | 눌림목 카드 — 차트는 `dynamic()` lazy import(초기 번들 절감), 손익비 근거(`targetBasis`)에 따라 안내 문구 표시 |
| `StockChart.tsx` | lightweight-charts 래퍼, `StockCard`에서 lazy load |
| `WatchlistCard.tsx` | 감시 종목 카드 |
| `Scorecard.tsx` | 성적 판정(`ScorecardVerdict`)·구간별 막대(`SegmentTable`) |
| `PerformanceTable.tsx` / `ExitSignalTable.tsx` | 스크리너 성적·보유 종목 포지션 표 |
| `LeadingSectors.tsx` | 주도 섹터 배지 |
| `MarketRegimeBadge.tsx` | 상승장/하락장 배지 |
| `RealestateTables.tsx` / `RealestateMap.tsx` | 부동산 표 · SVG choropleth 지도 |
| `NavLinks.tsx`(`app/` 아래) | 상단 탭, pill 버튼 |
| `LinkPendingSpinner.tsx` / `LoadingFallback.tsx` / `Spinner.tsx` | 위 "스피너 3종" 참고 |
| `TradeButton.tsx` | 가상 매수/매도 버튼(`api/trades` 호출, 가격은 서버가 직접 조회) |
| `StockNewsFeed.tsx` | 종목 뉴스 피드(로딩 중 인라인 스피너) |

## 라우팅 / 탭 순서 (2026-08 개편 이후)

```
/           부동산 동향 (홈)
/pullback   눌림목 종목 (구 홈)
/discover   종목 발굴 → 서브탭 순서: 횡보·조정 종목(기본) → 저점 매집 후보 → 패턴 검색
/positions  보유 종목 점검
/history    스크리너 성적
```

상단 네비 순서도 위와 동일(`app/NavLinks.tsx`의 `LINKS` 배열). 순서를 또 바꾸면
`app/layout.tsx`의 헤더 제목/탭 레이아웃과 CLAUDE.md의 `frontend/app/` 표도 같이 고칠 것.

## dev/preview 활용

`app/dev/preview/page.tsx`에 각 컴포넌트의 대표 상태(상승/하락/표본부족/미수집/부호반대)를
픽스처로 채운 미리보기가 있다. 새 UI를 만들 때:

1. 여기에 케이스 추가(특히 극단값)
2. `SUPABASE_URL=dummy SUPABASE_SERVICE_KEY=dummy npx next dev -p 3111`로 띄우고
3. Playwright 스크린샷으로 320/390/1000px 확인 후 배포

이 절차 없이 "타입체크·빌드 통과"만으로 UI 변경을 완료로 보고하지 말 것 — 레이아웃 깨짐과
색상 오류는 둘 다 안 잡는다.
