#!/bin/bash
set -e

echo "=== Installing frontend dependencies ==="
cd frontend && npm install && cd ..

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

echo "=== Setup complete! Run 'cd frontend && npm run dev' to start ==="
