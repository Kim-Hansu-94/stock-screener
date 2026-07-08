# kimhansu-vault — 옵시디언 볼트 & LLM 위키 설계

날짜: 2026-07-08

## 목적

Claude Code와 나눈 수많은 대화를 "언제, 어떤 세션에서 했는지" 찾기 어렵다는 문제를 해결한다.
세션별 요약 노트와 Claude의 auto-memory를 하나의 GitHub 저장소에 모아,
옵시디언(또는 GitHub 웹)에서 개인 위키처럼 열람할 수 있게 한다.

## 저장소

- 이름: `kimhansu-vault` (GitHub, **private**)
- 이 저장소 전체가 곧 옵시디언 볼트다.

```
kimhansu-vault/
├── memory/        ← Claude auto-memory 폴더 미러 (user/feedback/project/reference 노트)
│   └── MEMORY.md
├── sessions/      ← 세션별 요약 노트
│   └── YYYY-MM-DD-<주제>.md
└── README.md
```

- `memory/` 원본은 `/home/codespace/.claude/projects/-workspaces-stock-screener/memory/`에 그대로 유지된다
  (Claude가 매 세션 읽는 위치). 볼트의 `memory/`는 열람용 미러이며, push 시점마다 최신으로 복사한다.

## 세션 노트 형식

```markdown
---
date: 2026-07-04
tags: [주식스크리너, 백테스트, 파이프라인]
---

# 2026-07-04 — 백테스트 기능 구축

## 요약
- 3~5줄 불릿 요약

## 관련
[[project_stock_screener]]
```

- 파일명: `YYYY-MM-DD-<주제-슬러그>.md`
- 제목: `날짜 — 주제`
- 요약: 3~5줄 (상세 대화 흐름은 넣지 않음)
- 하단 `[[링크]]`로 관련 memory 노트 연결 → 옵시디언 그래프에서 세션↔메모리 연결이 보인다

## 워크플로우

### 과거 세션 소급 (1회성, 오늘 실행)
- 기존 세션 jsonl 11개를 모두 요약해 `sessions/` 노트로 생성
- 파일이 크므로(최대 ~6MB) 서브에이전트로 분담 처리
- 같은 날짜에 여러 세션이 있으면 주제로 구분

### 신규 세션 (지속)
- 자동 훅 없음. 대화가 마무리되는 시점에 Claude가 먼저
  "오늘 세션 요약해서 볼트에 저장할까요?"라고 묻는다.
- 승인 시: 세션 노트 생성 → `memory/` 미러 갱신 → commit → push

### 열람
- **회사/외부**: 브라우저로 GitHub 저장소 열람 (로그인 필요, 설치 불필요)
- **집 PC**: 옵시디언 설치(무료, 가입 불필요) → `git clone` → "폴더를 볼트로 열기"
  - 커뮤니티 플러그인 **Obsidian Git**으로 자동 pull 설정 권장
- HTML 정적 사이트 배포(Quartz 등)는 개인/투자 내용 노출 위험이 있어 채택하지 않음.
  필요해지면 비공개 배포 방식으로 추후 검토.

## 범위 밖

- 유튜브 요약 자동화 파이프라인 (별도 설계 예정)
- 세션 종료 자동 훅
- HTML 퍼블리싱
