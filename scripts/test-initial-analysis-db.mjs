import { startTestPostgres } from './test-postgres.mjs';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Disposable native PostgreSQL only; no external database, credentials or TCP listener.
const cluster = startTestPostgres('initial');
const args = cluster.args();
try {
  execFileSync(cluster.psql, args, { env: cluster.env, input: `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE migration_executor LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
    ALTER DATABASE postgres OWNER TO migration_executor; REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    CREATE TABLE public.rate_limits(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,key text,identifier text,timestamp timestamptz DEFAULT now());
    ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY; ALTER TABLE public.rate_limits OWNER TO migration_executor;
    CREATE FUNCTION public.cleanup_old_rate_limits() RETURNS void LANGUAGE sql AS $$ DELETE FROM public.rate_limits $$;
    ALTER FUNCTION public.cleanup_old_rate_limits() OWNER TO migration_executor;`, encoding: 'utf8' });
  const migrationArgs = cluster.args('migration_executor');
  for (const name of ['20260923060000_server_only_limiter.sql', '20260925040000_transcript_vendor_spend.sql', '20260925050000_initial_analysis_spend.sql', '20260925060000_shared_transcript_cache.sql', '20260925070000_initial_analysis_completion.sql']) {
    execFileSync(cluster.psql, migrationArgs, { env: cluster.env, input: readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'), encoding: 'utf8' });
  }
  const result = spawnSync('npx', ['vitest', 'run', 'tests/initial-analysis-db.test.ts'], {
    env: cluster.env, stdio: 'inherit',
  });
  assert.equal(result.status, 0, 'Initial-analysis SQL and route integration');
} finally { cluster.stop(); }
