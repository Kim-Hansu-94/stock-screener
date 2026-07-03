---
name: feedback-show-files-inline
description: "When asking the user to review a file (e.g. a spec doc), paste its content directly in the chat instead of telling them to open it themselves"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b0dd6e20-a3c7-4a11-a623-08e537c23687
---

When a workflow step (e.g. brainstorming's "user reviews written spec" gate) calls for the user to review a file, show the file's content directly in the chat response rather than just pointing to the path and asking them to open it.

**Why:** User said "앞으로 이런거 봐야되면 내가 열게하지말고 너가 여기서 바로 보여줘" (don't make me open it myself, show it to me right here) after being asked to go read a spec file on disk.

**How to apply:** Any time a skill or workflow says to present a file for user review/approval (specs, plans, configs), paste the relevant content into the chat message itself. Still mention the file path for reference, but don't rely on the user opening it externally.
