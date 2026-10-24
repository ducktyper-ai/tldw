import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

// Each invocation owns a fresh PostgreSQL 17 cluster. It never accepts a URL,
// password or existing database, and listens only on its private Unix socket.
function connection(root, bin, kind) {
  const socket = join(root, 'socket');
  return {
    root, kind, psql: join(bin, 'psql'),
    args: (role = 'postgres', database = 'postgres') => [
      '-X', '--no-password', '-h', socket, '-p', '5432', '-U', role, '-d', database,
      '-v', 'ON_ERROR_STOP=1', '-At',
    ],
  };
}

export function startTestPostgres(kind) {
  if (!/^(limiter|spend|initial|cache)$/.test(kind)) throw new Error('Unknown test cluster kind');
  // macOS locale discovery can start threads before PostgreSQL forks. Pin the
  // same C locale as initdb, including in a worker's otherwise empty environment.
  const env = { ...process.env, LC_ALL: 'C' };
  const initdb = process.env.LONGCUT_TEST_PG_BINDIR
    ? join(resolve(process.env.LONGCUT_TEST_PG_BINDIR), 'initdb') : 'initdb';
  const version = execFileSync(initdb, ['--version'], { encoding: 'utf8', env });
  if (!/PostgreSQL\) 17\./.test(version)) throw new Error('Database tests require PostgreSQL 17');
  const bin = process.env.LONGCUT_TEST_PG_BINDIR
    ? realpathSync(process.env.LONGCUT_TEST_PG_BINDIR)
    : realpathSync(execFileSync('pg_config', ['--bindir'], { encoding: 'utf8', env }).trim());
  // /tmp keeps the Unix socket path below PostgreSQL's platform length limit.
  const root = realpathSync(mkdtempSync(`/tmp/longcut-${kind}-test-${process.pid}-`));
  chmodSync(root, 0o700);
  const data = join(root, 'data');
  const socket = join(root, 'socket');
  let started = false;
  function stop() {
    if (started) {
      execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore', env });
      started = false;
    }
    rmSync(root, { recursive: true, force: true });
  }
  try {
    mkdirSync(socket, { mode: 0o700 });
    execFileSync(join(bin, 'initdb'), ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8'], { encoding: 'utf8', env });
    writeFileSync(join(data, 'postgresql.auto.conf'), [
      "listen_addresses = ''", `unix_socket_directories = '${socket}'`,
      'unix_socket_permissions = 0700', "shared_buffers = '16MB'", 'max_connections = 40',
    ].join('\n') + '\n');
    execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-l', join(root, 'postgres.log'), '-w', '-t', '30', 'start'], { encoding: 'utf8', env });
    started = true;
    writeFileSync(join(root, 'test-cluster.json'), JSON.stringify({ kind, bin }), { mode: 0o600 });
    return { ...connection(root, bin, kind), env: { ...env, LONGCUT_TEST_PG_ROOT: root }, stop };
  } catch (error) {
    // Retain the server's actual failure before deleting the disposable cluster.
    try {
      const log = readFileSync(join(root, 'postgres.log'), 'utf8');
      if (error instanceof Error) error.message += '\nPostgreSQL startup log:\n' + log;
    } catch { /* The server may have failed before opening its log. */ }
    // pg_ctl can time out after starting the server. Stop it before removing data.
    try { execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore', env }); } catch {}
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function readTestPostgres(kind) {
  const root = process.env.LONGCUT_TEST_PG_ROOT;
  if (!root) return null;
  const info = lstatSync(root);
  const prefix = `longcut-${kind}-test-`;
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()
    || (info.mode & 0o077) !== 0 || !basename(root).startsWith(prefix)
    || resolve(root) !== realpathSync(root) || realpathSync(join(root, '..')) !== realpathSync('/tmp')) {
    throw new Error('Expected an owned disposable test cluster');
  }
  const marker = JSON.parse(readFileSync(join(root, 'test-cluster.json'), 'utf8'));
  if (marker.kind !== kind || readFileSync(join(root, 'data', 'PG_VERSION'), 'utf8').trim() !== '17') {
    throw new Error('Unexpected test cluster identity or PostgreSQL version');
  }
  return connection(root, marker.bin, kind);
}
