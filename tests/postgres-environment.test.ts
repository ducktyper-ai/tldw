import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postgresTestEnvironment, readTestPostgres, startTestPostgres } from '../scripts/test-postgres.mjs';

const nativeBin = process.env.LONGCUT_TEST_PG_BINDIR;
const fixtures: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/longcut-pg-env-'));
  fixtures.push(root);
  return root;
}
function executable(path: string, body: string) {
  writeFileSync(path, '#!/usr/bin/env node\n' + body + '\n', { mode: 0o700 });
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('removes every PG variable while preserving the explicit harness configuration', () => {
  for (const key of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGPASSWORD', 'PGOPTIONS', 'pg_future_option']) {
    vi.stubEnv(key, 'synthetic-test-value');
  }
  vi.stubEnv('LONGCUT_TEST_PG_BINDIR', '/explicit/test/bin');
  vi.stubEnv('LC_ALL', 'inherited-locale');
  const env = postgresTestEnvironment();
  expect(Object.keys(env).filter(key => /^PG/i.test(key))).toEqual([]);
  expect(env.LONGCUT_TEST_PG_BINDIR).toBe('/explicit/test/bin');
  expect(env.LC_ALL).toBe('C');
});

it('checks the initdb selected by pg_config rather than an unrelated PATH binary', () => {
  const pathBin = fixture(), selectedBin = fixture();
  executable(join(pathBin, 'initdb'), "console.log('initdb (PostgreSQL) 17.11')");
  executable(join(pathBin, 'pg_config'), `console.log(${JSON.stringify(selectedBin)})`);
  executable(join(selectedBin, 'initdb'), "if (process.argv[2] !== '--version') process.exit(99); console.log('initdb (PostgreSQL) 18.0')");
  vi.stubEnv('LONGCUT_TEST_PG_BINDIR', undefined);
  vi.stubEnv('PATH', pathBin + ':' + process.env.PATH);
  expect(() => startTestPostgres('limiter')).toThrow('Database tests require PostgreSQL 17');
});

describe.skipIf(!nativeBin)('native PostgreSQL environment boundary', () => {
  it('ignores poisoned hostaddr, service and credential settings in parent and child connections', () => {
    const files = fixture();
    writeFileSync(join(files, 'services'), '[longcut_trap]\nhostaddr=not-an-ip\n');
    writeFileSync(join(files, 'passwords'), '*:*:*:*:synthetic-password\n', { mode: 0o600 });
    for (const [key, value] of Object.entries({
      PGHOSTADDR: 'not-an-ip', PGSERVICE: 'longcut_trap', PGSERVICEFILE: join(files, 'services'),
      PGPASSFILE: join(files, 'passwords'), PGPASSWORD: 'synthetic-password',
      PGDATABASE: 'not_the_test_database', PGUSER: 'not_the_test_user', PGOPTIONS: '-c invalid.option=value',
    })) vi.stubEnv(key, value);
    const cluster = startTestPostgres('limiter');
    try {
      vi.stubEnv('LONGCUT_TEST_PG_ROOT', cluster.root);
      const child = readTestPostgres('limiter')!;
      for (const connection of [cluster, child]) {
        expect(Object.keys(connection.env).filter(key => /^PG/i.test(key))).toEqual([]);
        const result = execFileSync(connection.psql, connection.args(), {
          env: connection.env, encoding: 'utf8',
          input: "SELECT inet_server_addr() IS NULL; SHOW data_directory;",
        }).trim().split('\n');
        expect(result).toEqual(['t', join(cluster.root, 'data')]);
      }
      // Negative control never names a real network address: inherited libpq
      // configuration fails locally before any connection can be attempted.
      const inherited = spawnSync(cluster.psql, cluster.args(), {
        env: process.env, encoding: 'utf8', input: 'SELECT 1;',
      });
      expect(inherited.status).not.toBe(0);
      expect(inherited.stderr).toContain('not-an-ip');
    } finally { cluster.stop(); }
    expect(existsSync(cluster.root)).toBe(false);
  }, 30_000);

  it('cleans up an owned cluster that has already stopped', () => {
    const cluster = startTestPostgres('limiter');
    try {
      execFileSync(join(nativeBin!, 'pg_ctl'), ['-D', join(cluster.root, 'data'), '-m', 'immediate', '-w', 'stop'], { env: cluster.env });
    } finally { cluster.stop(); }
    expect(existsSync(cluster.root)).toBe(false);
    expect(() => cluster.stop()).not.toThrow();
  }, 30_000);

  it('retains data when stop fails and the owned server is still running', () => {
    const wrapper = fixture();
    for (const name of ['initdb', 'psql']) symlinkSync(join(nativeBin!, name), join(wrapper, name));
    executable(join(wrapper, 'pg_ctl'), `
      const { spawnSync } = require('node:child_process');
      if (process.argv.includes('stop')) process.exit(42);
      const result = spawnSync(${JSON.stringify(join(nativeBin!, 'pg_ctl'))}, process.argv.slice(2), { env: process.env, stdio: 'inherit' });
      process.exit(result.status ?? 1);
    `);
    vi.stubEnv('LONGCUT_TEST_PG_BINDIR', wrapper);
    const cluster = startTestPostgres('limiter');
    try {
      expect(() => cluster.stop()).toThrow('server shutdown is unconfirmed');
      expect(existsSync(join(cluster.root, 'data', 'PG_VERSION'))).toBe(true);
      expect(execFileSync(cluster.psql, cluster.args(), { env: cluster.env, encoding: 'utf8', input: 'SELECT 1;' }).trim()).toBe('1');
    } finally {
      // The wrapper affects only this fixture. Stop with the real tool, then
      // let status=3 authorize deletion through the normal cleanup path.
      execFileSync(join(nativeBin!, 'pg_ctl'), ['-D', join(cluster.root, 'data'), '-m', 'immediate', '-w', 'stop'], { env: cluster.env });
      cluster.stop();
    }
    expect(existsSync(cluster.root)).toBe(false);
  }, 30_000);
});
