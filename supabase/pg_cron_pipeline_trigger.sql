-- Supabase SQL 에디터에서 1회 실행.
--
-- 문제: GitHub Actions의 schedule(cron)은 SLA 없는 best-effort라서 이 저장소의
-- 스케줄 실행이 매일 9~14시간씩 지연됐다(2026-06-30~07-09 실측). 분을 :47로
-- 옮겨도(6cca487) 효과가 없었고, 07-09에는 트리거 예정 시각에서 3시간이 지나도록
-- 실행이 큐에 잡히지도 않았다. 아침 8시 스크리너가 저녁에 도는 원인.
--
-- 해결: 시간이 정확한 Supabase pg_cron이 매일 06:30 KST(= 21:30 UTC)에
-- GitHub API(workflow_dispatch)로 파이프라인을 직접 실행한다.
-- 06:30인 이유: 미장 마감(05~06시 KST) 직후 + 파이프라인 소요 50~80분을 감안하면
-- 아침 8시 확인 전에 결과가 준비된다. 새벽 3~4시는 미장이 아직 장중이라 불가.
-- GitHub 쪽 schedule은 pg_cron이 죽었을 때의 백업으로 남기되, 워크플로의
-- precheck 잡이 "최근 18시간 내 성공 실행"을 확인해 중복 실행을 건너뛴다.
--
-- 사전 준비: GitHub fine-grained PAT 1개
--   github.com → Settings → Developer settings → Fine-grained tokens → Generate
--   - Repository access: Only select repositories → stock-screener
--   - Permissions: Actions → Read and write
--   - Expiration: 최대한 길게 (만료되면 트리거가 조용히 멈추므로 만료일을 캘린더에 기록)
-- 발급받은 토큰을 아래 1)의 <PAT> 자리에 붙여넣고 이 파일 전체를 실행한다.

-- 0) 확장 활성화 (이미 켜져 있으면 no-op)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1) PAT를 Vault에 저장 (SQL 히스토리에 남지 않도록 Vault 사용)
select vault.create_secret('<PAT>', 'github_pat_actions');
-- 나중에 토큰 갱신 시:
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'github_pat_actions'),
--     '<새 PAT>');

-- 2) 매일 06:30 KST(21:30 UTC, 일~목 UTC = 월~금 KST 새벽)에 파이프라인 트리거 (전체 실행)
select cron.schedule(
  'trigger-stock-pipeline',
  '30 21 * * 0-4',
  $$
  select net.http_post(
    url := 'https://api.github.com/repos/Kim-Hansu-94/stock-screener/actions/workflows/pipeline.yml/dispatches',
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

-- 2b) 매일 16:30 KST(07:30 UTC, 월~금)에 KR 전용 파이프라인 트리거.
--   06:30 실행은 한국장 개장(09:00) 전이라 KR 데이터가 늘 전날치로 밀린다.
--   한국장 마감(15:30) 직후 이 트리거가 당일 KR 종가를 반영한다.
--   inputs.mode=kr_only → 워크플로가 `python -m src.main --kr-only`로 실행해
--   미장(이 시각엔 폐장) 블록과 무거운 yfinance/Russell 수집을 건너뛴다.
--   workflow_dispatch라 precheck(18h 중복 방지)를 항상 통과한다.
select cron.schedule(
  'trigger-stock-pipeline-kr-evening',
  '30 7 * * 1-5',
  $$
  select net.http_post(
    url := 'https://api.github.com/repos/Kim-Hansu-94/stock-screener/actions/workflows/pipeline.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'github_pat_actions'),
      'Accept', 'application/vnd.github+json',
      'User-Agent', 'supabase-pg-cron',
      'Content-Type', 'application/json'
    ),
    body := '{"ref":"master","inputs":{"mode":"kr_only"}}'::jsonb
  )
  $$
);

-- 3) 즉시 1회 테스트 (오늘 실행분 수동 트리거 겸).
--    실행 후 몇 초 내에 GitHub → Actions 탭에 새 workflow_dispatch 실행이 떠야 한다.
select net.http_post(
  url := 'https://api.github.com/repos/Kim-Hansu-94/stock-screener/actions/workflows/pipeline.yml/dispatches',
  headers := jsonb_build_object(
    'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'github_pat_actions'),
    'Accept', 'application/vnd.github+json',
    'User-Agent', 'supabase-pg-cron',
    'Content-Type', 'application/json'
  ),
  body := '{"ref":"master"}'::jsonb
);

-- 4) 확인용 쿼리 (테스트 응답 status가 204면 성공)
--   select status, content from net._http_response order by id desc limit 1;
--   select jobname, schedule, active from cron.job;
