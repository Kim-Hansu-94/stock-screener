# 유튜브 요약 자동화 — 설계

날짜: 2026-07-08

## 목적

부동산/주식 유튜버가 영상을 올리면 자동으로 한국어 요약 노트를 만들어
kimhansu-vault(옵시디언 볼트)에 쌓는다. 매일 아침 확인만 하면 되게 한다.

## 대상 채널 (4개, `channels.json`으로 관리)

1. 부읽남TV_내집마련부터건물주까지
2. 신사임당
3. 소수몽키
4. 오선의 미국 증시 라이브

채널 추가/삭제는 `channels.json` 수정만으로 가능해야 한다.

## 구조 — 전부 kimhansu-vault 저장소 안

```
kimhansu-vault/
├── .github/workflows/youtube.yml   ← 매일 07:00 KST (cron '0 22 * * *' UTC) + workflow_dispatch
├── scripts/
│   ├── channels.json               ← 채널 목록 (이름, channel_id, 기본 태그)
│   ├── youtube_digest.py           ← 메인 스크립트 (탐지→자막→요약→노트 생성)
│   └── state.json                  ← 처리 완료 영상 ID + 실패 영상 재시도 목록
└── youtube/                        ← 요약 노트 (YYYY-MM-DD-<채널>-<제목슬러그>.md)
```

- 저장소가 자기 자신에 커밋하므로 기본 `GITHUB_TOKEN`으로 push 가능 — 추가 PAT 불필요.
- 시크릿은 `GEMINI_API_KEY` 하나만 등록.

## 데이터 흐름

### 매일 아침 (cron)

1. 채널별 RSS 피드(`https://www.youtube.com/feeds/videos.xml?channel_id=...`)에서
   최근 영상 목록 조회 — 무료, API 키 불필요, 최근 ~15개 노출
2. `state.json`에 없는 새 영상만 선별. 라이브 중/예약 영상은 건너뛰고 다음 실행에서 재확인
3. 한국어 자막(수동 자막 우선, 없으면 자동 생성 자막) 다운로드
4. Gemini(무료 티어, gemini-flash 계열)로 요약 → `youtube/` 노트 생성
5. `state.json` 갱신 → commit → push

### 한 달치 소급 백필 (최초 1회, 수동 실행)

- `workflow_dispatch` 입력 `backfill_days` (기본 0 = 백필 안 함)
- RSS는 15개 한계가 있으므로 백필은 yt-dlp로 채널별 최근 N일 영상 목록을 뽑아
  같은 파이프라인으로 처리
- 예상 물량 60~80개 — Gemini 무료 일일 한도(~250 요청) 안. 분당 한도(~10 RPM)
  때문에 영상 간 sleep을 넣어 총 30분~1시간 소요 예상

## 노트 형식

```markdown
---
date: 2026-07-08
channel: 소수몽키
title: 영상 제목
url: https://youtu.be/<id>
tags: [유튜브, 미국주식]
---

## 핵심 요약
- 3~5줄 불릿

## 주요 내용
- 종목/지역/정책 등 구체적 언급 정리

## 시사점
- 투자 관점에서 참고할 점 1~2줄
```

- 노트는 반드시 한국어
- 파일명: `YYYY-MM-DD-<채널>-<제목슬러그>.md` (날짜는 영상 업로드일)

## 에러 처리

- **자막 IP 차단**: GitHub Actions 서버 IP에서 유튜브 자막 요청이 차단될 수 있다.
  1차 youtube-transcript-api 실패 시 yt-dlp 자막 다운로드로 재시도.
  그래도 실패하면 `state.json`의 실패 목록에 기록하고 다음날 재시도.
  3회 연속 실패 시 "요약 실패" 표시 노트를 남겨 조용히 누락되지 않게 한다.
- **자막 없는 영상**: 실패와 동일하게 재시도 후 실패 노트 처리
- **Gemini 한도 초과/일시 오류**: 지수 백오프 재시도, 그래도 실패하면 실패 목록에
  넣고 다음 실행에서 처리 (일일 한도 소진 시 자연스럽게 다음날로 이월)
- **워크플로우 전체 실패**: Actions 실패 알림(GitHub 기본)으로 확인

## 준비물 (사용자)

- Google 계정으로 aistudio.google.com에서 Gemini API 키 발급 (무료, 카드 불필요)
- kimhansu-vault 저장소 시크릿 `GEMINI_API_KEY` 등록 (구현 시 안내)

## 테스트

1. 채널 1개·영상 2~3개 제한 모드로 workflow_dispatch 수동 실행 → 노트 품질 확인
2. 품질 승인 후 30일 백필 1회 실행
3. 이후 매일 cron 자동 실행

## 범위 밖

- PDF 생성 (마크다운 노트로 확정)
- 이메일/알림 발송
- 영상 화면(슬라이드 등) 분석 — 자막 텍스트만 사용
- 실시간(업로드 즉시) 처리 — 하루 1회 배치로 충분
