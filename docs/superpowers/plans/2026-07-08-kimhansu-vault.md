# kimhansu-vault 구축 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 세션 요약 + auto-memory를 담는 private GitHub 저장소(=옵시디언 볼트)를 만들고 과거 세션 9개를 소급 요약해 채운다.

**Architecture:** 코드 없는 콘텐츠 저장소. `memory/`는 기존 auto-memory 폴더의 미러, `sessions/`는 세션별 요약 노트. 과거 세션 jsonl은 서브에이전트가 분담 요약한다.

**Tech Stack:** git, gh CLI, 마크다운. 테스트 프레임워크 없음 — 각 태스크의 검증은 파일 존재/내용 확인과 push 성공 여부.

## Global Constraints

- 저장소 이름: `kimhansu-vault`, **private**, 소유자 `Kim-Hansu-94`
- 모든 노트는 한국어
- 세션 노트 파일명: `YYYY-MM-DD-<주제-슬러그>.md` (슬러그는 한글 가능)
- 세션 노트 형식 (spec 그대로):
  ```markdown
  ---
  date: YYYY-MM-DD
  tags: [태그1, 태그2]
  ---

  # YYYY-MM-DD — 주제

  ## 요약
  - 3~5줄 불릿

  ## 관련
  [[관련_메모리_노트]]
  ```
- `[[링크]]` 대상은 `memory/` 안에 실존하는 파일명(확장자 제외)만 사용
- auto-memory 원본 위치는 변경하지 않는다: `/home/codespace/.claude/projects/-workspaces-stock-screener/memory/`
- 로컬 볼트 작업 위치: `/workspaces/kimhansu-vault`

---

### Task 1: 저장소 생성 + 뼈대

**Files:**
- Create: `/workspaces/kimhansu-vault/README.md`
- Create: `/workspaces/kimhansu-vault/sessions/` (빈 디렉토리)
- Create: `/workspaces/kimhansu-vault/memory/` (미러 복사)

**Interfaces:**
- Produces: push 가능한 git 저장소 `/workspaces/kimhansu-vault` (Task 2·3이 여기에 노트 추가)

- [ ] **Step 1: private 저장소 생성**

```bash
gh repo create Kim-Hansu-94/kimhansu-vault --private --description "LLM wiki — Claude 세션 요약 + 메모리 볼트"
```

Expected: `https://github.com/Kim-Hansu-94/kimhansu-vault` 출력.
실패 시(Codespaces 토큰 권한 부족): 사용자에게 github.com에서 직접 private 저장소 `kimhansu-vault`를 만들어달라고 요청하고 대기.

- [ ] **Step 2: clone 및 뼈대 생성**

```bash
git clone https://github.com/Kim-Hansu-94/kimhansu-vault /workspaces/kimhansu-vault
mkdir -p /workspaces/kimhansu-vault/sessions
cp -r /home/codespace/.claude/projects/-workspaces-stock-screener/memory /workspaces/kimhansu-vault/memory
```

- [ ] **Step 3: README 작성**

`/workspaces/kimhansu-vault/README.md`:

```markdown
# kimhansu-vault

Claude Code 세션 요약 + 메모리를 모은 개인 위키 (옵시디언 볼트).

- `sessions/` — 세션별 요약 노트 (`YYYY-MM-DD-주제.md`)
- `memory/` — Claude auto-memory 미러 (원본: Codespaces 내 Claude 메모리 폴더, push 시점마다 복사)

## 보는 법
- 웹: 이 저장소를 GitHub에서 그대로 열람
- 옵시디언: 이 저장소를 clone 후 "폴더를 볼트로 열기" (+ Obsidian Git 플러그인으로 자동 pull 권장)
```

- [ ] **Step 4: 커밋 + push**

```bash
cd /workspaces/kimhansu-vault && git add -A && git commit -m "Vault 뼈대: README, memory 미러" && git push -u origin main
```

Expected: push 성공. GitHub 웹에서 README 확인 가능.

### Task 2: 과거 세션 9개 소급 요약

**Files:**
- Read: `/home/codespace/.claude/projects/-workspaces-stock-screener/*.jsonl` (현재 세션 `bd2311d0-*.jsonl` 제외 9개)
- Create: `/workspaces/kimhansu-vault/sessions/*.md` (세션당 1개, 총 9개)

**Interfaces:**
- Consumes: Task 1의 `/workspaces/kimhansu-vault` 저장소
- Produces: `sessions/` 노트 9개 (Task 3이 검토·push)

- [ ] **Step 1: 세션 목록과 날짜 확인**

```bash
ls -la --time-style=long-iso /home/codespace/.claude/projects/-workspaces-stock-screener/*.jsonl
```

각 파일의 mtime을 세션 날짜로 사용. 현재 세션 `bd2311d0-4c1f-4566-b617-674ab244bbda.jsonl`은 제외.

- [ ] **Step 2: 서브에이전트 3개로 분담 요약 (병렬)**

Agent 도구(general-purpose)로 3개 병렬 디스패치, 각 에이전트당 jsonl 3개씩 배정. 각 에이전트 프롬프트에 포함할 내용:

- 배정된 jsonl 파일 경로 (3개)
- jsonl 구조 안내: 한 줄이 JSON 하나, `type: "user"`/`"assistant"` 메시지의 `message.content`에서 텍스트만 추출. 파일이 크므로 `jq`나 `python`으로 사용자 메시지와 어시스턴트 텍스트만 뽑아 읽을 것 (도구 호출 결과는 건너뛰기)
- Global Constraints의 노트 형식 전문 (형식 그대로 복사해 전달)
- `memory/`에 실존하는 노트 이름 목록: `project_stock_screener`, `project_hanwha_position`, `feedback_*` 9개 — `[[링크]]`는 이 중에서만
- 출력: `/workspaces/kimhansu-vault/sessions/YYYY-MM-DD-<주제>.md` 로 직접 Write
- 노트는 반드시 한국어

- [ ] **Step 3: 결과 검증**

```bash
ls /workspaces/kimhansu-vault/sessions/ | wc -l   # Expected: 9
grep -L "^## 요약" /workspaces/kimhansu-vault/sessions/*.md   # Expected: 출력 없음
```

누락되거나 형식이 깨진 노트는 해당 jsonl을 직접 확인해 보완.

### Task 3: 링크 검증 + 최종 push

**Files:**
- Modify: `/workspaces/kimhansu-vault/sessions/*.md` (링크 수정 시)

**Interfaces:**
- Consumes: Task 2의 세션 노트 9개

- [ ] **Step 1: 깨진 [[링크]] 검사**

```bash
cd /workspaces/kimhansu-vault
grep -oh "\[\[[^]]*\]\]" sessions/*.md | sort -u
ls memory/ | sed 's/\.md$//'
```

sessions의 링크 대상이 memory 파일명 목록에 전부 존재하는지 대조. 없는 링크는 가장 가까운 실존 노트로 교체하거나 삭제.

- [ ] **Step 2: 커밋 + push**

```bash
cd /workspaces/kimhansu-vault && git add -A && git commit -m "과거 세션 9개 소급 요약 노트 추가" && git push
```

Expected: push 성공.

### Task 4: 지속 워크플로우를 메모리에 저장

**Files:**
- Create: `/home/codespace/.claude/projects/-workspaces-stock-screener/memory/project_kimhansu_vault.md`
- Modify: `/home/codespace/.claude/projects/-workspaces-stock-screener/memory/MEMORY.md` (인덱스 1줄 추가)

**Interfaces:**
- Consumes: Task 3까지 완료된 볼트

- [ ] **Step 1: 메모리 노트 작성**

`project_kimhansu_vault.md`:

```markdown
---
name: project-kimhansu-vault
description: 세션 요약+메모리 볼트 저장소 운영 방법 — 대화 마무리 시 요약 저장을 먼저 물어볼 것
metadata:
  type: project
---

`Kim-Hansu-94/kimhansu-vault` (private) = 사용자의 옵시디언 볼트. 로컬 clone: `/workspaces/kimhansu-vault`.

**대화가 마무리되는 시점에 Claude가 먼저 "오늘 세션 요약해서 볼트에 저장할까요?"라고 물어볼 것.**
승인 시: `sessions/YYYY-MM-DD-<주제>.md` 노트 생성 (frontmatter date/tags, 요약 3~5줄, 하단 [[메모리링크]])
→ memory/ 폴더를 볼트에 다시 복사(미러 갱신) → commit → push.

사용자는 회사에선 GitHub 웹으로, 집에선 옵시디언(설치 예정)으로 열람. [[project_stock_screener]]
```

- [ ] **Step 2: MEMORY.md에 인덱스 추가**

`MEMORY.md`에 한 줄 추가:

```markdown
- [Kimhansu Vault](project_kimhansu_vault.md) — 세션 끝날 때 "볼트에 저장할까요?" 먼저 묻고, 승인 시 요약 노트+memory 미러 push
```

- [ ] **Step 3: 볼트 미러 갱신 + push**

```bash
cp /home/codespace/.claude/projects/-workspaces-stock-screener/memory/*.md /workspaces/kimhansu-vault/memory/
cd /workspaces/kimhansu-vault && git add -A && git commit -m "memory 미러 갱신 (vault 운영 노트 추가)" && git push
```

Expected: push 성공. GitHub에서 `memory/project_kimhansu_vault.md` 확인 가능.
