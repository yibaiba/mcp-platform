import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fixtureMcp } from '../tests/fixtureMcp.ts';
const execute = promisify(execFile);
const home = await mkdtemp(join(tmpdir(), 'local-native-clients-'));
const fixture = await fixtureMcp();
let connector;
try {
  await mkdir(join(home, '.codex'));
  await writeFile(
    join(home, '.codex', 'config.toml'),
    '# keep native comment\n[mcp_servers.native]\ncommand="node"\nargs=["--version"]\nenv_vars=["NATIVE_TEST"]\nenabled=false\n',
  );
  await writeFile(
    join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        native: { type: 'http', url: fixture.url, headers: { 'X-Local-Test': 'before' } },
      },
    }),
  );
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    PI_CODING_AGENT_DIR: join(home, '.pi'),
    NATIVE_TEST: 'isolated-native-reference',
  };
  delete env.CLAUDE_CONFIG_DIR;
  connector = spawn(
    resolve('connector/bin/connector'),
    ['manage', '--data-dir', join(home, 'state')],
    { env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const link = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Connector startup timed out')), 10000);
    connector.once('error', reject);
    connector.stderr.on('data', (part) => {
      output += part;
      const found = /http:\/\/127\.0\.0\.1:\d+\/#open=[a-f0-9]+/.exec(output)?.[0];
      if (found) {
        clearTimeout(timer);
        resolve(found);
      }
    });
  });
  const url = new URL(link);
  const origin = url.origin;
  const session = await fetch(`${origin}/local-api/v1/session`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: url.hash.slice(6) }),
  });
  assert.equal(session.status, 200);
  const { csrf } = await session.json();
  const cookie = session.headers.get('set-cookie').split(';')[0];
  async function request(input) {
    const response = await fetch(`${origin}/local-api/v1/request`, {
      method: 'POST',
      headers: {
        Origin: origin,
        Cookie: cookie,
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  for (const client of ['codex', 'claude']) {
    const state = await request({ action: 'state' });
    const resource = Object.values(state.resources).find(
      (r) => r.clients.includes(client) && r.name === 'native',
    );
    assert.ok(resource);
    const content = structuredClone(resource.content);
    if (client === 'codex') content.enabled = true;
    else content.headers['X-Local-Test'] = 'after';
    await request({
      action: 'edit',
      id: resource.id,
      content,
      expectedDigest: resource.digest,
      expectedRevision: state.revision,
      operationId: randomUUID(),
    });
  }
  const codex = await execute(
    process.env.CODEX_BIN ?? 'codex',
    ['mcp', 'get', 'native', '--json'],
    { env, cwd: home, timeout: 20000 },
  );
  assert.equal(JSON.parse(codex.stdout).enabled, true);
  assert.ok(
    (await readFile(join(home, '.codex', 'config.toml'), 'utf8')).includes('# keep native comment'),
  );
  const claude = await execute(process.env.CLAUDE_BIN ?? 'claude', ['mcp', 'get', 'native'], {
    env,
    cwd: home,
    timeout: 20000,
  });
  assert.ok(claude.stdout.includes('native'));
  assert.ok(claude.stdout.includes('after'));
  assert.equal(fixture.count(), 0);
  console.log(
    'PASS: isolated installed Codex and Claude Code read configurations edited by the real connector; no model or business calls',
  );
} finally {
  if (connector?.exitCode === null) {
    const stopped = new Promise((resolve) => connector.once('exit', resolve));
    connector.kill('SIGINT');
    await stopped;
  }
  await fixture.close();
  await rm(home, { recursive: true, force: true });
}
