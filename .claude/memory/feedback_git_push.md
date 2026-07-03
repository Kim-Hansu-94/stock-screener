---
name: feedback-git-push
description: Always push to GitHub after committing — user deploys via Vercel which requires the remote to be updated
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6f088580-a03a-4448-9e2f-04396ca24369
---

Always run `git push origin master` immediately after `git commit`. Do not say the task is done until the push is confirmed.

**Why:** Vercel auto-deploys from GitHub. A local-only commit does nothing for the user — they can't see it in Vercel Deployments and the fix isn't live. User was frustrated when I said "다 했습니다" after only committing locally.

**How to apply:** Every time I make a code change: edit → commit → push, all in one flow before reporting completion.
