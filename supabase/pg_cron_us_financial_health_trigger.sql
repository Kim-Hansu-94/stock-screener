-- Supabase SQL 에디터에서 1회 실행.
--
-- 매일 21:00 KST(12:00 UTC, 월~금)에 US 재무건전성 전용 워크플로
-- (.github/workflows/us_financial_health.yml)를 트리거한다. 본 파이프라인
-- 트리거(pg_cron_pipeline_trigger.sql)와 같은 이유로 GitHub schedule이 아닌
-- pg_cron이 정시를 보장한다.
--
-- pg_cron_pipeline_trigger.sql에서 이미 만들어 둔 Vault 시크릿
-- (github_pat_actions)을 그대로 재사용한다 — 새 PAT 발급 불필요. 그 파일을
-- 먼저 실행해 시크릿이 존재해야 한다.

select cron.schedule(
  'trigger-us-financial-health',
  '0 12 * * 1-5',
  $$
  select net.http_post(
    url := 'https://api.github.com/repos/Kim-Hansu-94/stock-screener/actions/workflows/us_financial_health.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'github_pat_actions'),
      'Accept', 'application/vnd.github+json',
      'User-Agent', 'supabase-pg-cron',
      'Content-Type', 'application/json'
    ),
    body := '{"ref":"master"}'::jsonb
  )
  $$
);

-- 확인용 쿼리:
--   select jobname, schedule, active from cron.job;
