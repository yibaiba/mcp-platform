import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
export async function verifyRestRestart({ origin, headers, compose, waitForHealth }) {
  const management = async (path, value) => {
    const response = await fetch(`${origin}/api/v1${path}`, {
      method: value === undefined ? 'GET' : 'POST',
      headers,
      body: value === undefined ? undefined : JSON.stringify(value),
      signal: AbortSignal.timeout(60000),
    });
    assert.ok(
      response.ok,
      `Management ${path} returned ${response.status}: ${await response.clone().text()}`,
    );
    return response.json();
  };
  const declaration = {
    declaration: {
      version: 1,
      name: 'compose-rest',
      connections: {
        source: {
          config: {
            name: 'REST restart acceptance',
            adapter: 'direct',
            mode: 'managed',
            transport: 'stdio',
            command: 'node',
            args: [
              '--import',
              'tsx',
              'tests/fixtureRestStdio.mts',
              '/app/.data/rest-acceptance-effects',
            ],
            cwd: { directoryRef: 'workspace' },
            env: { ACCEPTANCE_SECRET: { secretRef: 'compose-secret' } },
          },
        },
      },
      profiles: {
        client: {
          name: 'REST restart acceptance',
          tools: [{ connection: 'source', name: 'restart_echo' }],
        },
      },
    },
    mappings: { directories: { workspace: '/app' } },
  };
  const pending = await management('/config/manifests/apply', declaration);
  assert.equal(pending.status, 'pending');
  const secret = await fetch(`${origin}/api/v1/config/secrets`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ name: 'compose-secret', value: randomUUID() }),
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(secret.status, 200);
  const ready = await management('/config/manifests/compose-rest');
  assert.equal(
    ready.status,
    'ready',
    'One saved declaration must resolve automatically after configuring its secret',
  );
  const connection = { id: ready.entries.find((entry) => entry.kind === 'connection').objectId };
  const profile = { id: ready.entries.find((entry) => entry.kind === 'profile').objectId };
  const tool = (await management('/tools')).find((row) => row.connectionId === connection.id);
  assert.ok(tool);
  const reapplied = await management('/config/manifests/apply', declaration);
  assert.equal(reapplied.revision, ready.revision);
  assert.equal(reapplied.entries.find((entry) => entry.kind === 'profile').objectId, profile.id);
  console.log(
    'PASS: fresh Compose database accepts one manifest; secret configuration resolves exact capabilities automatically; repeated apply is idempotent',
  );
  const key = await management(`/profiles/${profile.id}/keys`, {});
  const client = (token) => (path, value, idempotencyKey) =>
    fetch(`${origin}/mcp/${profile.id}${path}`, {
      method: value === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: value === undefined ? undefined : JSON.stringify(value),
      signal: AbortSignal.timeout(60000),
    });
  const api = client(key.token);
  const runningKey = await management(`/profiles/${profile.id}/keys`, {});
  const runningApi = client(runningKey.token);
  const prefix = randomUUID();
  const complete = await api(
    `/rest/tools/${tool.id}`,
    { marker: `${prefix}-complete` },
    'complete',
  );
  assert.equal(complete.status, 200);
  const completeId = complete.headers.get('x-call-id');
  const waitingResponse = await api(
    `/rest/tools/${tool.id}`,
    { marker: `${prefix}-waiting`, wait: true },
    'waiting',
  );
  assert.equal(waitingResponse.status, 202);
  const waiting = await waitingResponse.json();
  assert.equal(waiting.status, 'waiting');
  const running = runningApi(
    `/rest/tools/${tool.id}`,
    { marker: `${prefix}-running`, delay: 15000 },
    'running',
  ).then(
    async (response) => {
      await response.text();
    },
    () => undefined,
  );
  let runningId;
  const deadline = Date.now() + 10000;
  while (!runningId && Date.now() < deadline) {
    const records = await management(`/calls?profileId=${profile.id}&status=running`);
    runningId = records[0]?.id;
    if (!runningId) await setTimeout(50);
  }
  assert.ok(runningId, 'Running call must be registered before restart');
  let reachedUpstream = false;
  while (!reachedUpstream && Date.now() < deadline) {
    const output = await compose(['exec', '-T', 'server', 'node', '--input-type=module', '-e', "import {readFile} from 'node:fs/promises';const rows=(await readFile('/app/.data/rest-acceptance-effects','utf8')).split('\\n');console.log(rows.includes(process.argv[1]));", `${prefix}-running`]);
    reachedUpstream = output.trim().endsWith('true');
    if (!reachedUpstream) await setTimeout(50);
  }
  assert.ok(reachedUpstream, 'Actual upstream side effect must precede the restart');
  await compose(['restart', 'server']);
  await waitForHealth();
  await running;
  for (const [id, caller] of [[waiting.callId, api], [runningId, runningApi]]) {
    const response = await caller(`/rest/calls/${id}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'unknown');
  }
  const saved = await api(`/rest/calls/${completeId}/result`);
  assert.equal(saved.status, 200);
  assert.ok(JSON.stringify(await saved.json()).includes(`${prefix}-complete`));
  const duplicate = await api(
    `/rest/tools/${tool.id}`,
    { marker: `${prefix}-complete` },
    'complete',
  );
  assert.equal(duplicate.status, 200);
  assert.equal(
    (await api(`/rest/tools/${tool.id}`, { marker: `${prefix}-waiting`, wait: true }, 'waiting'))
      .status,
    409,
  );
  assert.equal(
    (
      await api(`/rest/calls/${waiting.callId}/answer`, {
        interactionId: waiting.interactionId,
        responses: {},
      })
    ).status,
    409,
  );
  const output = await compose([
    'exec',
    '-T',
    'server',
    'node',
    '--input-type=module',
    '-e',
    "import {readFile} from 'node:fs/promises';process.stdout.write(await readFile('/app/.data/rest-acceptance-effects','utf8'));",
  ]);
  const markers = output.trim().split('\n');
  for (const suffix of ['complete', 'waiting', 'running'])
    assert.equal(markers.filter((row) => row === `${prefix}-${suffix}`).length, 1);
  console.log(
    'PASS: actual container restart preserves encrypted completed REST results; running/waiting are unknown; idempotency and side-effect file prove no replay',
  );
}
