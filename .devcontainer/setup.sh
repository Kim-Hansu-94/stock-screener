#!/bin/bash
set -e

echo "=== Installing frontend dependencies ==="
cd frontend && npm install && cd ..

echo "=== Relocating .next cache to container-local disk ==="
# /workspaces는 Codespaces 영속 디스크(네트워크 기반)라 쓰기 지연이 커서
# Next.js가 "Slow filesystem detected" 경고를 띄움.
# .next를 클라우드 컨테이너 내부의 빠른 디스크로 심볼릭 링크 (회사 PC와 무관, 전부 클라우드 내부).
NEXT_CACHE_DIR="$HOME/.next-cache/stock-screener-frontend"
mkdir -p "$NEXT_CACHE_DIR"
if [ ! -L frontend/.next ]; then
  rm -rf frontend/.next
  ln -s "$NEXT_CACHE_DIR" frontend/.next
fi
# 빌드 청크가 $HOME 쪽에서 실행되면 node_modules 탐색 경로가 어긋나므로 링크 필요
ln -sfn "$(pwd)/frontend/node_modules" "$NEXT_CACHE_DIR/node_modules"

echo "=== Installing pipeline dependencies ==="
cd pipeline && pip install -r requirements.txt && cd ..

echo "=== Writing environment files from Codespaces secrets ==="

# frontend/.env.local
{
  echo "SUPABASE_URL=${SUPABASE_URL}"
  echo "SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}"
  echo "KIS_APP_KEY=${KIS_APP_KEY}"
  echo "KIS_APP_SECRET=${KIS_APP_SECRET}"
} > frontend/.env.local

# pipeline/.env
{
  echo "SUPABASE_URL=${SUPABASE_URL}"
  echo "SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}"
  echo "KIS_APP_KEY=${KIS_APP_KEY}"
  echo "KIS_APP_SECRET=${KIS_APP_SECRET}"
} > pipeline/.env

echo "=== Installing Claude Code and plugins ==="
npm install -g @anthropic-ai/claude-code
claude plugins marketplace add obra/superpowers-marketplace
claude plugins install superpowers@superpowers-marketplace
claude plugins install superpowers-chrome@superpowers-marketplace

echo "=== Setting up Claude Code user environment ==="

# Write user-level Claude settings (autoCompact, dark theme, plugins)
mkdir -p "$HOME/.claude"
cat > "$HOME/.claude/settings.json" << 'CLAUDE_SETTINGS'
{
  "enabledPlugins": {
    "superpowers@superpowers-marketplace": true,
    "superpowers-chrome@superpowers-marketplace": true
  },
  "extraKnownMarketplaces": {
    "superpowers-marketplace": {
      "source": {
        "source": "github",
        "repo": "obra/superpowers-marketplace"
      }
    }
  },
  "theme": "dark",
  "remoteControlAtStartup": true,
  "inputNeededNotifEnabled": true,
  "agentPushNotifEnabled": true,
  "autoCompactEnabled": true,
  "autoCompactWindow": 100000
}
CLAUDE_SETTINGS

# Copy memory files to Claude's project memory directory for this Codespace
MEMORY_DIR="$HOME/.claude/projects/-workspaces-stock-screener/memory"
mkdir -p "$MEMORY_DIR"
cp .claude/memory/* "$MEMORY_DIR/"

echo "=== Setup complete! Run 'cd frontend && npm run dev' to start ==="
