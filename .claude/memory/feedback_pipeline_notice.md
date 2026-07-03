---
name: feedback-pipeline-notice
description: 작업 완료 후 파이프라인 실행 필요 여부를 항상 명시해야 함
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6f088580-a03a-4448-9e2f-04396ca24369
---

작업이 끝나면 "파이프라인 돌려야 됩니다" 또는 "파이프라인 안 돌려도 됩니다"를 반드시 명시한다.

**Why:** 유저가 직접 판단하지 않아도 되도록 — 빠뜨리면 불편함.

**How to apply:** 모든 작업 완료 메시지에 포함. 프론트엔드 전용 변경 → 불필요, DB 스키마/파이프라인 로직/수집 대상 변경 → 필요.
