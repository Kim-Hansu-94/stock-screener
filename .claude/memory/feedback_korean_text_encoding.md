---
name: feedback-korean-text-encoding
description: Korean text in tool call parameters (especially AskUserQuestion) occasionally comes out garbled — be extra careful
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6f088580-a03a-4448-9e2f-04396ca24369
---

Korean text typed into tool call parameters (observed specifically with AskUserQuestion question/option text) has come out garbled multiple times in this session — syllables corrupted into wrong-but-similar-looking characters (e.g. "함께" → "함껌", "천" → "춝", "러" → "끌"). Plain conversational replies typed directly as message text did not have this problem.

**Why:** Unclear root cause (possibly something about how rapidly-constructed Korean text inside structured JSON tool arguments gets encoded vs. free-form response text). The user got genuinely frustrated and swore when this happened ("아니 근데 씨발 진짜 한국말 똑바로 안할래?").

**How to apply:** When writing Korean inside tool call parameters (AskUserQuestion options/questions especially), go slower and double check the text before sending. If it happens again, apologize briefly once and immediately retype the same content as plain message text instead of retrying the same tool call structure — don't over-apologize repeatedly. Prefer putting clarifying questions in plain chat text rather than AskUserQuestion when the question is simple, since plain text generation hasn't shown this corruption.
