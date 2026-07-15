---
name: project-stock-screener
description: Status of the stock screener project (눌림목 매수 필터 + 시장분위기/주도섹터 웹사이트) in C:\Users\김한수\1. 주식
metadata: 
  node_type: memory
  type: project
  originSessionId: 6f088580-a03a-4448-9e2f-04396ca24369
---

User is building a stock screener website: daily-refreshed (8:30 KST) list of Korean (KRX) + US (S&P500+Nasdaq100) stocks matching a "눌림목 매수" (pullback-in-an-uptrend) pattern, gated by market regime (bull/bear) and leading-sector detection. Full design lives in `docs/superpowers/specs/2026-06-25-stock-screener-design.md`.

**Why:** User wants to screen for low-risk-entry stocks in currently-leading sectors during bull markets, inspired by a past 400%+ win on 에바테크놀로지스 (Eva Technologies, LiDAR sensor maker) bought near a chart bottom. Chart-pattern-similarity search for "find the next Eva Technologies" and backtesting are deliberately deferred to later phases (2 and 3) — not yet built.

**Status as of 2026-06-25 (session end):**
- 1단계(MVP) Python data pipeline fully implemented in `pipeline/` via subagent-driven-development (14 tasks, plan at `docs/superpowers/plans/2026-06-25-stock-screener-pipeline.md`), all 36 tests passing, final whole-branch review done.
- GitHub repo created and pushed: https://github.com/Kim-Hansu-94/stock-screener (originally named just "-", renamed after GitHub's Actions UI failed to recognize the workflow file — see below).
- Supabase project created, schema applied (4 tables: market_regime, leading_sectors, screened_stocks, stock_price_history), RLS enabled with no policies yet (service_role bypasses it for the pipeline; public read policies still need to be added once the frontend is built).
- `pipeline/.env` has real credentials filled in locally; GitHub repo secrets (SUPABASE_URL, SUPABASE_SERVICE_KEY) registered.
- **Pipeline verified working end-to-end** by running `python -m pipeline.src.main` locally on 2026-06-25: wrote real data — KR/US both "bull", US leading sectors (Consumer Discretionary/Energy/Health Care), 2 US stocks passed the pullback filter (ROST, WYNN), KR had zero qualifying sectors/stocks that day (plausible real market condition, not a confirmed bug).
- **RESOLVED (2026-06-25, later same day):** The "workflow does not exist" GitHub Actions UI issue self-resolved. Confirmed via GitHub API (`/actions/workflows` and `/actions/workflows/{id}/runs`) that the "Daily Screener Pipeline" workflow is `active` and its first scheduled run (08:30 KST, event=schedule) completed with `conclusion: success`. No further action needed on this front — daily automation is live.

**Frontend built and merged (2026-06-26):** Next.js 16 (App Router) dashboard at `frontend/` in the same repo, built via brainstorming → writing-plans → subagent-driven-development (11-task plan at `docs/superpowers/plans/2026-06-25-stock-screener-frontend.md`, design at `docs/superpowers/specs/2026-06-25-stock-screener-frontend-design.md`). Single Server Component (`app/page.tsx`, `force-dynamic`) fetches market regime/leading sectors/screened stocks/full price history from Supabase server-side (service_role key, server-only) on every request — no separate chart API, all data fetched upfront since screened-stock counts are small. Tailwind + shadcn/ui, lightweight-charts v4 for candlestick+MA+volume charts that expand on card click with no extra fetch. Only automated tests are Vitest unit tests for two pure functions in `lib/calculations.ts`; everything else verified manually via dev server + browser (including a mobile viewport check) against real production data. Final whole-branch review (opus) found no Critical/Important blockers; merged to master and pushed to GitHub (commit 2190856).

**Vercel: DONE & LIVE (confirmed 2026-07-15).** The site is deployed and auto-deploying. Vercel project `vercel.com/kimhansu/stock-screener` is connected to the GitHub repo; `vercel[bot]` runs a Production deployment on every master push (many successful deployments 2026-07-07 onward). Latest master commit status = `Vercel: success`. The user has been using it for a while — do NOT tell them to connect Vercel; that instruction is obsolete. Per-deployment URLs look like `stock-screener-<hash>-kimhansu.vercel.app`; the stable production domain lives in Vercel dashboard → Domains (not stored locally). To verify liveness without the user, use `gh api repos/Kim-Hansu-94/stock-screener/deployments` and its `/statuses` endpoint (environment_url).

**How to apply:** Vercel connection is complete — don't re-suggest it. Next planned work: 2단계 (chart-pattern-similarity search) and 3단계 (backtesting), both deliberately deferred per the original design spec. Recent in-progress work also includes an S&P 500 적립식(dollar-cost-averaging) tracking tab (see recent commits).

See also [[feedback-korean-text-encoding]].
