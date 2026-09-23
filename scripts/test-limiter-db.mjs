import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';

// Deliberately no URL/env input: this runner can only reach this local disposable container.
const container = 'longcut-limiter-test';
const database = `limiter_test_${Date.now()}`;
const args = ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-At'];
function sql(text) { return execFileSync('docker', args, { input: text, encoding: 'utf8' }).trim(); }
function denied(text) {
  const result = spawnSync('docker', args, { input: text, encoding: 'utf8' });
  assert.notEqual(result.status, 0, `Expected permission rejection: ${text}`);
  assert.match(result.stderr, /permission denied/);
}
execFileSync('docker', ['exec', container, 'createdb', '-U', 'postgres', database]);
const initial = readFileSync(new URL('../supabase/migrations/20241107000000_initial_schema.sql', import.meta.url), 'utf8');
const audit = readFileSync(new URL('../supabase/migrations/20251101120001_add_audit_and_rate_limit_tables.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20260923060000_server_only_limiter.sql', import.meta.url), 'utf8');
// Reproduce the actual table and ALL historical limiter policies, including permissive ones.
const table = initial.match(/CREATE TABLE IF NOT EXISTS public\.rate_limits \([\s\S]*?\);/)[0];
const policies = [...initial.matchAll(/CREATE POLICY [^;]*ON public\.rate_limits[\s\S]*?;/g)].map(match => match[0]).join('\n');
assert.equal(policies.match(/CREATE POLICY/g).length, 3);
sql(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  END $$;
  CREATE SCHEMA extensions; CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;
  GRANT USAGE ON SCHEMA extensions TO PUBLIC;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
  ${table}
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.rate_limits TO anon, authenticated, service_role;
  ${policies}
  ${audit.slice(audit.indexOf('CREATE TABLE IF NOT EXISTS rate_limits'))}
`);
assert.equal(sql("SELECT count(*) FROM pg_policies WHERE tablename = 'rate_limits'"), '4');
sql(migration);
assert.equal(sql("SELECT count(*) FROM pg_policies WHERE tablename = 'rate_limits'"), '1');
sql("INSERT INTO public.rate_limits(key, identifier, timestamp) VALUES ('ratelimit:expired', 'expired', now() - interval '32 days'), ('guest-analysis', 'permanent-guest', now() - interval '32 days')");

for (const role of ['anon', 'authenticated']) {
  for (const statement of [
    'SELECT * FROM public.rate_limits',
    "INSERT INTO public.rate_limits(key, identifier) VALUES ('forged', 'forged')",
    "UPDATE public.rate_limits SET key = 'forged'",
    'DELETE FROM public.rate_limits',
    "SELECT public.check_rate_limit_server('forged', 'forged', 60000, 10, true)",
    "SELECT public.guest_usage_server(ARRAY['forged'], true)",
    'SELECT public.cleanup_old_rate_limits()',
  ]) denied(`SET ROLE ${role}; ${statement};`);
  // Simulate a browser's authenticated or anonymous identity, while only the server
  // service role may execute the narrow persistence functions on its behalf.
  const identifier = `${role}:local-test`;
  const call = consume => `SELECT public.check_rate_limit_server('${identifier}', '${identifier}', 60000, 1, ${consume})`;
  const parse = output => JSON.parse(output.split('\n').at(-1));
  assert.equal(parse(sql(`SET ROLE service_role; ${call(false)};`)).allowed, true);
  assert.equal(parse(sql(`SET ROLE service_role; ${call(true)};`)).allowed, true);
  assert.equal(parse(sql(`SET ROLE service_role; ${call(false)};`)).allowed, false);
  assert.equal(parse(sql(`SET ROLE service_role; ${call(true)};`)).allowed, false);
  assert.equal(sql(`SELECT count(*) FROM public.rate_limits WHERE identifier = '${identifier}'`), '1');
  assert.equal(sql(`SET ROLE service_role; SELECT public.guest_usage_server(ARRAY['guest:${identifier}'], false)`).split('\n').at(-1), 'f');
  assert.equal(sql(`SET ROLE service_role; SELECT public.guest_usage_server(ARRAY['guest:${identifier}'], true)`).split('\n').at(-1), 't');
  assert.equal(sql(`SET ROLE service_role; SELECT public.guest_usage_server(ARRAY['guest:${identifier}'], false)`).split('\n').at(-1), 't');
}
// A required write failure cannot return an allowed decision.
sql(`CREATE FUNCTION public.reject_limiter_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated storage failure'; END $$;
  CREATE TRIGGER reject_limiter_write BEFORE INSERT ON public.rate_limits FOR EACH ROW EXECUTE FUNCTION public.reject_limiter_write();`);
const failedWrite = spawnSync('docker', args, { encoding: 'utf8', input:
  "SET ROLE service_role; SELECT public.check_rate_limit_server('write-failure', 'write-failure', 60000, 1, true);" });
assert.notEqual(failedWrite.status, 0);
assert.match(failedWrite.stderr, /simulated storage failure/);
assert.equal(sql("SELECT count(*) FROM public.rate_limits WHERE key = 'write-failure'"), '0');
sql('DROP TRIGGER reject_limiter_write ON public.rate_limits');
assert.match(sql("SET ROLE service_role; SELECT public.check_rate_limit_server('write-failure', 'write-failure', 60000, 1, true)"), /"allowed": true/);
// A SELECT privilege failure must error, not produce a filtered empty history.
sql('REVOKE SELECT ON public.rate_limits FROM limiter_executor');
denied("SET ROLE service_role; SELECT public.check_rate_limit_server('read-failure', 'read-failure', 60000, 1, true)");
sql('GRANT SELECT ON public.rate_limits TO limiter_executor');
assert.equal(sql("SELECT count(*) FROM public.rate_limits WHERE key = 'read-failure'"), '0');
assert.equal(sql("SELECT rolcanlogin OR rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = 'limiter_executor'"), 'f');
denied("SET ROLE limiter_executor; UPDATE public.rate_limits SET key = 'forged'");
assert.equal(sql("SELECT count(*) FROM public.rate_limits WHERE key = 'ratelimit:expired'"), '0');
assert.equal(sql("SELECT count(*) FROM public.rate_limits WHERE identifier = 'permanent-guest'"), '1');
const admissions = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
  const child = spawn('docker', args);
  let output = '';
  let errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve(JSON.parse(output.trim().split('\n').at(-1))) : reject(new Error(errors)));
  child.stdin.end("SET ROLE service_role; SELECT public.check_rate_limit_server('concurrent', 'concurrent', 60000, 1, true)");
})));
assert.equal(admissions.filter(result => result.allowed).length, 1);
assert.equal(sql("SELECT count(*) FROM public.rate_limits WHERE key = 'concurrent'"), '1');
console.log('PASS: historical policies, anonymous/authenticated isolation, server admission/read/write, guest persistence, retention, concurrency, failure and recovery.');
