# 유튜브 요약 자동화 (youtube digest) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 유튜브 채널 4개의 새 영상을 매일 아침 자동 요약해 kimhansu-vault의 `youtube/` 폴더에 마크다운 노트로 쌓는다 (+ 최초 1회 30일 소급).

**Architecture:** 모든 코드·노트·상태가 kimhansu-vault 저장소 안에 있다. GitHub Actions cron(매일 07:00 KST)이 `scripts/youtube_digest.py`를 실행 → RSS로 새 영상 탐지(백필은 yt-dlp 목록) → 한국어 자막 다운로드 → Gemini 무료 API 요약 → `youtube/` 노트 생성 → 자기 저장소에 커밋(기본 GITHUB_TOKEN, PAT 불필요).

**Tech Stack:** Python 3.11 표준 라이브러리(urllib, xml.etree, subprocess) + youtube-transcript-api + yt-dlp, Gemini REST API(v1beta generateContent), GitHub Actions.

## Global Constraints

- 작업 위치: `/workspaces/kimhansu-vault` (main 브랜치에 직접 커밋 — 콘텐츠 저장소 관례, 볼트 구축 때와 동일)
- push는 이 저장소 clone에 내장된 PAT 사용. **push 출력은 `2>&1 | grep -v github_pat`로 필터해 PAT 노출 금지**
- 모든 노트·주석·출력 메시지는 한국어
- 노트 형식·에러 처리 규칙은 spec(`docs/superpowers/specs/2026-07-08-youtube-summary-design.md`) 그대로:
  - 노트 파일명 `youtube/YYYY-MM-DD-<채널>-<제목슬러그>.md` (날짜 = 영상 업로드일)
  - frontmatter: date / channel / title / url / tags
  - 본문 섹션: `## 핵심 요약`(3~5불릿), `## 주요 내용`(5~8불릿), `## 시사점`(1~2불릿)
  - 자막 3회 연속 실패 → "요약 실패" 노트를 남기고 done 처리
- Gemini 무료 티어 준수: 요약 호출 사이 `time.sleep(8)` (분당 ~10회 제한), 모델 기본값 `gemini-2.5-flash`(env `GEMINI_MODEL`로 교체 가능)
- 시크릿은 `GEMINI_API_KEY` 하나만. 코드/로그에 키를 출력하지 않는다
- 테스트 프레임워크 없음 — 각 태스크 검증은 실제 실행 결과 확인 (볼트 구축 플랜과 동일 방식)

---

### Task 1: 뼈대 — channels.json(채널 ID 확인), requirements, 디렉토리

**Files:**
- Create: `/workspaces/kimhansu-vault/scripts/channels.json`
- Create: `/workspaces/kimhansu-vault/scripts/requirements.txt`
- Create: `/workspaces/kimhansu-vault/scripts/state.json`
- Create: `/workspaces/kimhansu-vault/youtube/` (빈 디렉토리, `.gitkeep`)

**Interfaces:**
- Produces: `channels.json` 스키마 `[{"name": str, "channel_id": str, "tags": [str]}]` — Task 2가 읽는다
- Produces: `state.json` 초기값 `{"done": {}, "failed": {}}` — Task 2~4가 읽고 쓴다

- [ ] **Step 1: 의존성 설치 및 requirements 작성**

```bash
pip install "youtube-transcript-api>=1.0" yt-dlp
```

`/workspaces/kimhansu-vault/scripts/requirements.txt`:

```
youtube-transcript-api>=1.0
yt-dlp
```

- [ ] **Step 2: 채널 ID 확인**

각 채널을 검색해 channel_id(UC로 시작하는 24자)를 얻는다:

```bash
for q in "부읽남TV 내집마련" "신사임당" "소수몽키" "오선의 미국 증시 라이브"; do
  yt-dlp --flat-playlist --playlist-items 1 --print "%(channel_id)s | %(channel)s" "ytsearch1:$q"
done
```

Expected: 줄마다 `UCxxxxxxxxxxxxxxxxxxxxxx | 채널명`.
각 ID를 RSS로 교차 검증 — 피드 제목이 실제 채널명과 일치해야 한다:

```bash
curl -s "https://www.youtube.com/feeds/videos.xml?channel_id=<UC...>" | grep -o "<title>[^<]*</title>" | head -1
```

검색 결과가 요청한 채널과 다르게 보이면(개명·양도된 채널 등) **추측하지 말고 사용자에게 채널 URL을 물어본다.**

- [ ] **Step 3: channels.json / state.json / youtube 디렉토리 생성**

`/workspaces/kimhansu-vault/scripts/channels.json` (channel_id는 Step 2에서 확인한 실제 값):

```json
[
  {"name": "부읽남TV", "channel_id": "<Step2 값>", "tags": ["유튜브", "부동산"]},
  {"name": "신사임당", "channel_id": "<Step2 값>", "tags": ["유튜브", "재테크"]},
  {"name": "소수몽키", "channel_id": "<Step2 값>", "tags": ["유튜브", "미국주식"]},
  {"name": "오선의미국증시", "channel_id": "<Step2 값>", "tags": ["유튜브", "미국증시"]}
]
```

`/workspaces/kimhansu-vault/scripts/state.json`:

```json
{"done": {}, "failed": {}}
```

```bash
mkdir -p /workspaces/kimhansu-vault/youtube && touch /workspaces/kimhansu-vault/youtube/.gitkeep
```

- [ ] **Step 4: 검증 — 4개 채널 RSS가 전부 영상을 반환하는지**

```bash
cd /workspaces/kimhansu-vault && python3 - <<'EOF'
import json, urllib.request, xml.etree.ElementTree as ET
ns = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015"}
for ch in json.load(open("scripts/channels.json")):
    xml = urllib.request.urlopen(f"https://www.youtube.com/feeds/videos.xml?channel_id={ch['channel_id']}", timeout=30).read()
    entries = ET.fromstring(xml).findall("a:entry", ns)
    print(ch["name"], len(entries), entries[0].find("a:title", ns).text if entries else "없음")
EOF
```

Expected: 채널마다 `이름 15 최신영상제목` 비슷한 줄. 0개인 채널이 있으면 channel_id 재확인.

- [ ] **Step 5: 커밋 + push**

```bash
cd /workspaces/kimhansu-vault && git add -A && git commit -m "유튜브 요약 뼈대: channels/state/requirements" && git push 2>&1 | grep -v github_pat
```

### Task 2: youtube_digest.py — 탐지·상태·노트 골격 (요약은 스텁)

**Files:**
- Create: `/workspaces/kimhansu-vault/scripts/youtube_digest.py`

**Interfaces:**
- Consumes: Task 1의 `channels.json`, `state.json`
- Produces: CLI `python3 scripts/youtube_digest.py [--backfill-days N] [--limit N] [--channels 이름,이름] [--dry-run]`
- Produces: 함수 `fetch_transcript(video_id) -> str` 자리(Task 3이 구현), `gemini_summarize(channel, title, transcript) -> str` 자리(Task 4가 구현) — 이 태스크에서는 `RuntimeError` 스텁

- [ ] **Step 1: 파일 전체 작성**

`/workspaces/kimhansu-vault/scripts/youtube_digest.py`:

```python
#!/usr/bin/env python3
"""유튜브 채널 새 영상을 요약해 볼트 youtube/ 노트로 저장한다.

매일: RSS로 새 영상 탐지. 백필: yt-dlp로 최근 N일 목록.
자막 실패는 state.json failed에 기록, 3회 누적 시 '요약 실패' 노트.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
NOTES_DIR = ROOT / "youtube"
KST = timezone(timedelta(hours=9))
MAX_FAILURES = 3
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
RSS_NS = {
    "a": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
}


def load_json(path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def save_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def rss_videos(channel_id):
    """RSS 피드의 최근 영상(최대 ~15개). [{'id','title','published'}] 최신순."""
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    xml = urllib.request.urlopen(url, timeout=30).read()
    out = []
    for e in ET.fromstring(xml).findall("a:entry", RSS_NS):
        out.append({
            "id": e.find("yt:videoId", RSS_NS).text,
            "title": e.find("a:title", RSS_NS).text or "",
            "published": (e.find("a:published", RSS_NS).text or "")[:10],
        })
    return out


def ytdlp_json(args_list, timeout=180):
    p = subprocess.run(["yt-dlp", *args_list], capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(f"yt-dlp 실패: {p.stderr.strip()[-300:]}")
    return p.stdout


def video_meta(video_id):
    """영상 메타데이터. live_status가 is_live/is_upcoming이면 아직 처리 불가."""
    out = ytdlp_json(["--dump-json", "--skip-download",
                      f"https://www.youtube.com/watch?v={video_id}"])
    d = json.loads(out)
    up = d.get("upload_date") or datetime.now(KST).strftime("%Y%m%d")
    return {
        "id": video_id,
        "title": d.get("title", video_id),
        "published": f"{up[:4]}-{up[4:6]}-{up[6:]}",
        "live_status": d.get("live_status"),
    }


def channel_recent_ids(channel_id, per_tab=60):
    """채널의 최근 영상 ID들 (일반 영상 + 라이브 다시보기 탭, 최신순)."""
    ids = []
    for tab in ("videos", "streams"):
        try:
            out = ytdlp_json(["--flat-playlist", "--print", "id",
                              "--playlist-end", str(per_tab),
                              f"https://www.youtube.com/channel/{channel_id}/{tab}"])
            ids.extend(out.split())
        except RuntimeError:
            pass  # 해당 탭이 없는 채널
    seen = set()
    return [i for i in ids if not (i in seen or seen.add(i))]


def backfill_videos(channel_id, days, done):
    """최근 days일 영상 목록. ID를 최신순으로 훑다가 기한 밖이면 그 탭은 중단."""
    cutoff = (datetime.now(KST) - timedelta(days=days)).strftime("%Y-%m-%d")
    out, stale = [], 0
    for vid in channel_recent_ids(channel_id):
        if vid in done:
            continue
        try:
            meta = video_meta(vid)
        except RuntimeError as e:
            print(f"  메타 실패 {vid}: {e}", file=sys.stderr)
            continue
        if meta["published"] < cutoff:
            stale += 1
            if stale >= 3:  # videos/streams 두 탭이 섞여 있어 여유 있게 3개 확인 후 중단
                break
            continue
        stale = 0
        out.append({"id": vid, "title": meta["title"], "published": meta["published"],
                    "live_status": meta["live_status"]})
    return out


def slugify(title, max_len=40):
    s = re.sub(r"[^\w가-힣]+", "-", title, flags=re.UNICODE).strip("-")
    return s[:max_len].rstrip("-") or "untitled"


def write_note(video, channel_name, tags, body):
    date = video.get("published") or datetime.now(KST).strftime("%Y-%m-%d")
    title = (video.get("title") or video["id"]).replace('"', "'")
    fname = f"{date}-{channel_name}-{slugify(title)}.md"
    front = (
        "---\n"
        f"date: {date}\n"
        f"channel: {channel_name}\n"
        f'title: "{title}"\n'
        f"url: https://youtu.be/{video['id']}\n"
        f"tags: [{', '.join(tags)}]\n"
        "---\n\n"
    )
    NOTES_DIR.mkdir(exist_ok=True)
    (NOTES_DIR / fname).write_text(front + body.rstrip() + "\n", encoding="utf-8")
    return fname


FAILURE_BODY = (
    "## 요약 실패\n"
    "- 자막을 3회 시도했지만 가져오지 못했습니다. 영상을 직접 확인해주세요.\n"
)


def fetch_transcript(video_id):
    raise RuntimeError("Task 3에서 구현")


def gemini_summarize(channel_name, title, transcript):
    raise RuntimeError("Task 4에서 구현")


def record_failure(state, video, channel, reason):
    """실패 횟수 누적, MAX_FAILURES 도달 시 실패 노트 + done 처리."""
    vid = video["id"]
    entry = state["failed"].get(vid, {"count": 0, "channel": channel["name"],
                                      "title": video.get("title", ""),
                                      "published": video.get("published", "")})
    entry["count"] += 1
    print(f"  실패({entry['count']}회) {vid}: {reason}", file=sys.stderr)
    if entry["count"] >= MAX_FAILURES:
        fname = write_note(video, channel["name"], channel["tags"], FAILURE_BODY)
        print(f"  실패 노트 생성: {fname}")
        state["done"][vid] = "failed"
        state["failed"].pop(vid, None)
    else:
        state["failed"][vid] = entry


def process_video(video, channel, state, dry_run):
    vid = video["id"]
    try:
        if video.get("live_status") is None:  # RSS 경로는 메타 미조회 상태
            meta = video_meta(vid)
            video.update(meta)
        if video.get("live_status") in ("is_live", "is_upcoming"):
            print(f"  라이브 중/예약 건너뜀: {video['title']}")
            return False
        transcript = fetch_transcript(vid)
    except Exception as e:
        record_failure(state, video, channel, e)
        return False
    print(f"  자막 {len(transcript)}자: {video['title']}")
    if dry_run:
        return False
    try:
        summary = gemini_summarize(channel["name"], video["title"], transcript)
    except Exception as e:
        record_failure(state, video, channel, e)
        return False
    fname = write_note(video, channel["name"], channel["tags"], summary)
    print(f"  노트 생성: {fname}")
    state["done"][vid] = video.get("published", "")
    state["failed"].pop(vid, None)
    time.sleep(8)  # Gemini 무료 티어 분당 한도
    return True


def main():
    ap = argparse.ArgumentParser(description="유튜브 요약 → 볼트 노트")
    ap.add_argument("--backfill-days", type=int, default=0, help="0이면 RSS 최신분만")
    ap.add_argument("--limit", type=int, default=0, help="채널당 최대 처리 수 (0=무제한)")
    ap.add_argument("--channels", default="", help="쉼표로 채널 이름 필터")
    ap.add_argument("--dry-run", action="store_true", help="자막까지만 확인, 저장 안 함")
    args = ap.parse_args()

    channels = load_json(SCRIPTS / "channels.json", [])
    if args.channels:
        want = set(args.channels.split(","))
        channels = [c for c in channels if c["name"] in want]
    state = load_json(SCRIPTS / "state.json", {"done": {}, "failed": {}})
    by_name = {c["name"]: c for c in channels}

    ok = 0
    # 1) 이전 실패분 재시도 (RSS 15개 창을 벗어나도 잊지 않도록)
    for vid, entry in list(state["failed"].items()):
        ch = by_name.get(entry.get("channel"))
        if not ch:
            continue
        print(f"[재시도] {entry.get('title') or vid}")
        video = {"id": vid, "title": entry.get("title", ""),
                 "published": entry.get("published", "")}
        ok += process_video(video, ch, state, args.dry_run)

    # 2) 채널별 새 영상
    for ch in channels:
        print(f"[{ch['name']}]")
        try:
            if args.backfill_days > 0:
                vids = backfill_videos(ch["channel_id"], args.backfill_days, state["done"])
            else:
                vids = rss_videos(ch["channel_id"])
            # 처리 완료·재시도 단계에서 이미 다룬 영상 제외
            vids = [v for v in vids
                    if v["id"] not in state["done"] and v["id"] not in state["failed"]]
        except Exception as e:
            print(f"  목록 조회 실패: {e}", file=sys.stderr)
            continue
        if args.limit > 0:
            vids = vids[:args.limit]
        vids.reverse()  # 오래된 것부터 처리 (중간 중단 시 이어가기 쉬움)
        for v in vids:
            ok += process_video(v, ch, state, args.dry_run)

    if not args.dry_run:
        save_json(SCRIPTS / "state.json", state)
    print(f"완료: 노트 {ok}개, 실패 대기 {len(state['failed'])}개")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 검증 — 탐지 로직만 (dry-run은 자막 스텁 때문에 아직 실패가 정상)**

```bash
cd /workspaces/kimhansu-vault && python3 - <<'EOF'
import sys; sys.path.insert(0, "scripts")
from youtube_digest import rss_videos, slugify
import json
ch = json.load(open("scripts/channels.json"))[2]  # 소수몽키
vids = rss_videos(ch["channel_id"])
print(len(vids), "개")
print(vids[0])
print(slugify(vids[0]["title"]))
EOF
```

Expected: `15 개` 내외, 최신 영상 dict(id/title/published), 한글 슬러그.

- [ ] **Step 3: dry-run이 스텁 에러를 '실패 기록'으로 처리하는지 확인**

```bash
cd /workspaces/kimhansu-vault && python3 scripts/youtube_digest.py --dry-run --limit 1 --channels 소수몽키
```

Expected: `실패(1회) ... Task 3에서 구현` 후 `완료: 노트 0개` — 크래시 없이 종료. dry-run이라 state.json 미변경(`git diff --stat` 비어 있음) 확인.

- [ ] **Step 4: 커밋 + push**

```bash
cd /workspaces/kimhansu-vault && git add scripts/youtube_digest.py && git commit -m "유튜브 요약 스크립트 골격: 탐지·상태·노트 (요약 스텁)" && git push 2>&1 | grep -v github_pat
```

### Task 3: 자막 다운로드 (youtube-transcript-api + yt-dlp 폴백)

**Files:**
- Modify: `/workspaces/kimhansu-vault/scripts/youtube_digest.py` (스텁 `fetch_transcript` 교체)

**Interfaces:**
- Produces: `fetch_transcript(video_id) -> str` — 한국어 자막 전문(공백 연결). 실패 시 예외 → `record_failure`가 받는다

- [ ] **Step 1: 스텁 교체**

`def fetch_transcript(video_id):` 스텁(`raise RuntimeError("Task 3에서 구현")` 포함 2줄)을 다음으로 교체:

```python
def fetch_transcript(video_id):
    """한국어 자막 전문. 1차 youtube-transcript-api, 실패 시 yt-dlp 폴백."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        fetched = YouTubeTranscriptApi().fetch(video_id, languages=["ko"])
        text = " ".join(s.text.strip() for s in fetched if s.text.strip())
        if text:
            return text
        raise RuntimeError("자막이 비어 있음")
    except Exception as first_err:
        try:
            return _transcript_via_ytdlp(video_id)
        except Exception as second_err:
            raise RuntimeError(f"1차: {first_err} / 폴백: {second_err}") from second_err


def _transcript_via_ytdlp(video_id):
    """yt-dlp로 ko 자막(vtt) 다운로드 후 텍스트만 추출."""
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(
            ["yt-dlp", "--skip-download", "--write-subs", "--write-auto-subs",
             "--sub-langs", "ko.*", "--sub-format", "vtt",
             "-o", f"{td}/%(id)s.%(ext)s",
             f"https://www.youtube.com/watch?v={video_id}"],
            capture_output=True, text=True, timeout=300, check=False)
        vtts = sorted(Path(td).glob("*.vtt"))
        if not vtts:
            raise RuntimeError("vtt 자막 파일 없음")
        lines, prev = [], None
        for raw in vtts[0].read_text(encoding="utf-8").splitlines():
            line = re.sub(r"<[^>]+>", "", raw).strip()
            if (not line or "-->" in line or line == "WEBVTT"
                    or line.startswith(("Kind:", "Language:")) or line.isdigit()):
                continue
            if line != prev:  # 자동 자막의 연속 중복 제거
                lines.append(line)
                prev = line
        text = " ".join(lines)
        if not text:
            raise RuntimeError("vtt에서 텍스트 추출 실패")
        return text
```

- [ ] **Step 2: 검증 — 실제 영상 1개 dry-run**

```bash
cd /workspaces/kimhansu-vault && python3 scripts/youtube_digest.py --dry-run --limit 1 --channels 소수몽키
```

Expected: `자막 NNNN자: <영상제목>` (수천 자 이상) 후 `완료: 노트 0개`. Codespace에서 두 경로 모두 실패하면 다른 채널로도 시도해보고, 전부 실패 시 IP 차단 가능성 — 에러 메시지를 기록하고 사용자와 상의(중단 조건).

Task 2 검증에서 남았을 수 있는 state.json의 failed 기록 정리:

```bash
cd /workspaces/kimhansu-vault && python3 -c "
import json,pathlib; p=pathlib.Path('scripts/state.json')
p.write_text(json.dumps({'done':{},'failed':{}},indent=2)+'\n')"
```

- [ ] **Step 3: 커밋 + push**

```bash
cd /workspaces/kimhansu-vault && git add scripts/ && git commit -m "자막 다운로드: transcript-api + yt-dlp 폴백" && git push 2>&1 | grep -v github_pat
```

### Task 4: Gemini 요약 + 실제 노트 생성

**Files:**
- Modify: `/workspaces/kimhansu-vault/scripts/youtube_digest.py` (스텁 `gemini_summarize` 교체)

**Interfaces:**
- Consumes: env `GEMINI_API_KEY` (필수), `GEMINI_MODEL` (선택)
- Produces: `gemini_summarize(channel_name, title, transcript) -> str` — `## 핵심 요약/주요 내용/시사점` 마크다운

- [ ] **Step 0 (사용자, 블로킹): Gemini API 키**

사용자에게 요청: aistudio.google.com → "Get API key" → 키 생성(무료, 카드 불필요) → 채팅으로 전달받아 이 세션에서는 `export GEMINI_API_KEY=...`로만 사용 (파일에 저장 금지). **키를 받을 때까지 이 태스크 진행 불가.**

- [ ] **Step 1: 스텁 교체**

`def gemini_summarize(channel_name, title, transcript):` 스텁을 다음으로 교체:

```python
PROMPT_TEMPLATE = """당신은 투자 유튜브 영상을 요약하는 어시스턴트입니다.
채널: {channel} / 영상 제목: {title}

아래 자막 전문을 읽고 정확히 다음 마크다운 형식으로만 한국어 요약을 작성하세요.
형식 밖의 텍스트(인사말, 코드펜스, 서두)는 출력하지 마세요.

## 핵심 요약
- (영상의 핵심 주장 3~5개 불릿)

## 주요 내용
- (언급된 종목/지역/정책/수치를 구체적으로 5~8개 불릿)

## 시사점
- (투자 관점에서 참고할 점 1~2개 불릿)

자막:
{transcript}"""


def gemini_summarize(channel_name, title, transcript):
    key = os.environ["GEMINI_API_KEY"]
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{GEMINI_MODEL}:generateContent?key={key}")
    prompt = PROMPT_TEMPLATE.format(channel=channel_name, title=title,
                                    transcript=transcript[:250000])
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}]}).encode()
    last = None
    for attempt in range(4):
        req = urllib.request.Request(url, body, {"Content-Type": "application/json"})
        try:
            resp = json.load(urllib.request.urlopen(req, timeout=180))
            text = resp["candidates"][0]["content"]["parts"][0]["text"].strip()
            if text.startswith("```"):
                text = re.sub(r"^```[a-z]*\n?|```$", "", text).strip()
            return text
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code in (429, 500, 503) and attempt < 3:
                time.sleep(20 * (attempt + 1))  # 지수 백오프
                continue
            raise RuntimeError(f"Gemini 실패: {last}") from e
        except (KeyError, IndexError) as e:
            raise RuntimeError(f"Gemini 응답 형식 이상: {resp.get('promptFeedback')}") from e
    raise RuntimeError(f"Gemini 재시도 소진: {last}")
```

- [ ] **Step 2: 검증 — 실제 노트 1개 생성**

```bash
cd /workspaces/kimhansu-vault && export GEMINI_API_KEY=<사용자 키> && \
  python3 scripts/youtube_digest.py --limit 1 --channels 소수몽키
```

Expected: `노트 생성: YYYY-MM-DD-소수몽키-....md`, `완료: 노트 1개`.
생성된 노트를 열어 확인: frontmatter 6줄 + 세 섹션 존재, 한국어, 내용이 영상 주제와 부합. **노트 전문을 사용자에게 채팅으로 보여주고 품질 승인을 받는다** (형식/말투 수정 요청 시 PROMPT_TEMPLATE 조정 후 재생성).

- [ ] **Step 3: state 확인**

```bash
cd /workspaces/kimhansu-vault && python3 -c "
import json; s=json.load(open('scripts/state.json')); print(len(s['done']), s['failed'])"
```

Expected: `1 {}`.

- [ ] **Step 4: 커밋 + push**

```bash
cd /workspaces/kimhansu-vault && git add scripts/ youtube/ && git commit -m "Gemini 요약 연결 + 첫 노트" && git push 2>&1 | grep -v github_pat
```

### Task 5: GitHub Actions 워크플로우 + 시크릿 + 원격 테스트

**Files:**
- Create: `/workspaces/kimhansu-vault/.github/workflows/youtube.yml`

**Interfaces:**
- Consumes: Task 4까지 완성된 `youtube_digest.py`, 저장소 시크릿 `GEMINI_API_KEY`
- Produces: cron(매일 22:00 UTC = 07:00 KST) + workflow_dispatch(backfill_days, limit, channels 입력)

- [ ] **Step 1: 워크플로우 작성**

`/workspaces/kimhansu-vault/.github/workflows/youtube.yml`:

```yaml
name: YouTube Digest

on:
  schedule:
    - cron: '0 22 * * *'   # 매일 07:00 KST
  workflow_dispatch:
    inputs:
      backfill_days:
        description: '소급 일수 (0 = RSS 최신분만)'
        default: '0'
      limit:
        description: '채널당 최대 영상 수 (0 = 무제한)'
        default: '0'
      channels:
        description: '채널 이름 필터 (쉼표 구분, 빈칸 = 전체)'
        default: ''

permissions:
  contents: write

concurrency:
  group: youtube-digest
  cancel-in-progress: false

jobs:
  digest:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: 의존성 설치
        run: pip install -r scripts/requirements.txt

      - name: 요약 실행
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
        run: |
          python scripts/youtube_digest.py \
            --backfill-days "${{ inputs.backfill_days || '0' }}" \
            --limit "${{ inputs.limit || '0' }}" \
            --channels "${{ inputs.channels || '' }}"

      - name: 커밋 & 푸시
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add youtube/ scripts/state.json
          git diff --cached --quiet || git commit -m "유튜브 요약 $(TZ=Asia/Seoul date +%F)"
          git push
```

- [ ] **Step 2 (사용자, 블로킹): 저장소 시크릿 등록**

사용자에게 안내: kimhansu-vault → Settings → Secrets and variables → Actions → New repository secret → 이름 `GEMINI_API_KEY`, 값은 Task 4의 키. (또는 세션에 gh 권한이 있으면 `gh secret set GEMINI_API_KEY -R Kim-Hansu-94/kimhansu-vault` 시도 — 실패하면 웹으로 안내.)

- [ ] **Step 3: 커밋 + push**

```bash
cd /workspaces/kimhansu-vault && git add .github/ && git commit -m "매일 아침 유튜브 요약 워크플로우" && git push 2>&1 | grep -v github_pat
```

- [ ] **Step 4: 원격 제한 테스트 (채널 1개, 영상 1개)**

```bash
gh workflow run youtube.yml -R Kim-Hansu-94/kimhansu-vault -f limit=1 -f channels=부읽남TV
sleep 30 && gh run list -R Kim-Hansu-94/kimhansu-vault --workflow=youtube.yml --limit 1
```

완료까지 `gh run watch <run-id> -R Kim-Hansu-94/kimhansu-vault` 또는 반복 조회.
Expected: 성공, 저장소에 노트 커밋 확인 (`git -C /workspaces/kimhansu-vault pull`).

**실패가 자막 차단(두 경로 모두 실패) 때문이면**: 이는 알려진 Actions IP 차단 리스크. 즉시 중단하고 사용자와 대안 논의 (예: Codespace에서 주기 실행, Webshare 등 프록시, self-hosted runner). **추측으로 프록시 코드를 추가하지 말 것.**

### Task 6: 30일 백필 + 마무리 (README/메모리 갱신)

**Files:**
- Modify: `/workspaces/kimhansu-vault/README.md`
- Modify: `/home/codespace/.claude/projects/-workspaces-stock-screener/memory/project_kimhansu_vault.md`

**Interfaces:**
- Consumes: Task 5의 동작 확인된 워크플로우

- [ ] **Step 1: 백필 실행 (원격)**

```bash
gh workflow run youtube.yml -R Kim-Hansu-94/kimhansu-vault -f backfill_days=30
```

60~80개 영상 × (자막 + 8초 sleep + Gemini) ≈ 30분~1시간. `gh run watch`로 추적.
타임아웃(120분)으로 끊겨도 state.json이 커밋된 지점까지는 보존 — 같은 명령 재실행하면 이어서 처리.

- [ ] **Step 2: 결과 검증**

```bash
git -C /workspaces/kimhansu-vault pull 2>&1 | tail -1
ls /workspaces/kimhansu-vault/youtube/ | wc -l
grep -L "^## 핵심 요약" /workspaces/kimhansu-vault/youtube/*.md
```

Expected: 노트 수십 개. `grep -L` 출력은 "요약 실패" 노트만 (있다면 몇 개인지 사용자에게 보고).

- [ ] **Step 3: README에 youtube/ 설명 추가**

`/workspaces/kimhansu-vault/README.md`의 폴더 목록에 한 줄 추가:

```markdown
- `youtube/` — 구독 채널 영상 자동 요약 (매일 07:00 KST GitHub Actions, `scripts/channels.json`으로 채널 관리)
```

- [ ] **Step 4: 메모리 노트 갱신**

`project_kimhansu_vault.md` 말미에 추가:

```markdown
볼트에는 유튜브 요약 자동화도 산다: `.github/workflows/youtube.yml`(매일 07:00 KST) →
`scripts/youtube_digest.py` → `youtube/` 노트. 채널 추가/삭제는 `scripts/channels.json` 수정.
시크릿 `GEMINI_API_KEY`(Gemini 무료 티어). 자막 실패 3회면 "요약 실패" 노트가 남는다.
```

- [ ] **Step 5: 커밋 + push + 완료 보고**

```bash
cd /workspaces/kimhansu-vault && git add -A && git commit -m "README: youtube 폴더 안내" && git push 2>&1 | grep -v github_pat
cp /home/codespace/.claude/projects/-workspaces-stock-screener/memory/*.md /workspaces/kimhansu-vault/memory/
cd /workspaces/kimhansu-vault && git add memory/ && git commit -m "memory 미러 갱신" && git push 2>&1 | grep -v github_pat
```

사용자에게 보고: 백필 노트 수, 실패 수, 내일 아침부터 자동 실행됨.
