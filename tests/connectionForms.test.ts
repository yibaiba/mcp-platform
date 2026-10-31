import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  hiddenArgument,
  maskArguments,
  parseArgumentLines,
  restoreHiddenArguments,
} from '../packages/contracts/src/connectionFields.js';
import {
  connectionLocation,
  connectionNextStep,
} from '../apps/web/src/features/connections/connectionHints.js';
import { parseJsonObject } from '../apps/web/src/features/connections/jsonField.js';
import { harness } from './harness.js';
import { fixtureMcp } from './fixtureMcp.js';

let h: Awaited<ReturnType<typeof harness>>;
let upstream: Awaited<ReturnType<typeof fixtureMcp>>;
beforeAll(async () => {
  h = await harness();
  upstream = await fixtureMcp();
});
afterAll(async () => {
  await h?.close();
  await upstream?.close();
});
type Row = {
  id: string;
  url?: string;
  urlHasQuery?: boolean;
  command?: string;
  args?: string[];
  status: string;
  error: string | null;
  deviceOffline?: boolean;
};

test('arguments are entered one per line; a pasted JSON array still works; errors are readable', () => {
  expect(parseArgumentLines('')).toEqual([]);
  expect(parseArgumentLines('  /workspace/tools/x.mts  \n\n--name\r\nmy notes \n')).toEqual([
    '/workspace/tools/x.mts',
    '--name',
    'my notes',
  ]);
  expect(parseArgumentLines(' ["-y", "pkg with space"] ')).toEqual(['-y', 'pkg with space']);
  expect(() => parseArgumentLines('["-y",]')).toThrow(/JSON 数组解析失败.*每行填一个参数/);
  expect(() => parseArgumentLines('[1, 2]')).toThrow('必须是字符串');
  expect(() => parseJsonObject('{"env": ', '高级配置')).toThrow('高级配置不是有效的 JSON');
  expect(() => parseJsonObject('[]', '高级配置')).toThrow('必须是 JSON 对象');
  expect(parseJsonObject('  ', 'x')).toEqual({});
});

test('sensitive arguments are masked for the form and restored only in their original line', () => {
  const previous = { args: ['--token', 's3cret', '--verbose'], sensitiveArguments: [1] };
  const masked = maskArguments(previous.args, previous.sensitiveArguments);
  expect(masked).toEqual(['--token', hiddenArgument, '--verbose']);
  expect(restoreHiddenArguments(previous, [...masked, '--extra'])).toEqual([
    '--token',
    's3cret',
    '--verbose',
    '--extra',
  ]);
  expect(restoreHiddenArguments(previous, ['--token', 'new', '--verbose'])).toEqual([
    '--token',
    'new',
    '--verbose',
  ]);
  expect(() => restoreHiddenArguments(previous, [hiddenArgument, '--token'])).toThrow('第 1 行');
});

test('the next step matches the failure instead of always blaming address, network and credentials', () => {
  const http = { adapter: 'direct', transport: 'http', mode: 'existing', deviceId: null };
  const stdio = { adapter: 'device', transport: 'stdio', mode: 'managed', deviceId: 'd1' };
  const generic = '检查服务地址、网络和凭据';
  expect(connectionNextStep({ ...stdio, deviceOffline: true }, 'whatever')).toContain(
    '重新运行安装命令',
  );
  expect(connectionNextStep(stdio, '设备离线，无法执行', 'DEVICE_OFFLINE')).toContain(
    '连接器不在线',
  );
  expect(connectionNextStep(stdio, 'spawn notes-mcp ENOENT')).toContain('那台电脑上找不到');
  expect(connectionNextStep(stdio, 'MCP error -32000: Connection closed')).not.toContain(generic);
  expect(connectionNextStep(http, 'fetch failed: connect ECONNREFUSED 127.0.0.1:1')).toContain(
    '平台访问不到这个地址',
  );
  expect(connectionNextStep({ ...http, adapter: 'device' }, 'ECONNREFUSED')).toContain(
    '这台电脑访问不到',
  );
  expect(connectionNextStep(http, 'HTTP 401 Unauthorized')).toContain('凭据');
  // A sandbox refusal carries its own fix; no misleading "command not found" hint is added.
  expect(
    connectionNextStep(
      { ...stdio, adapter: 'direct', deviceId: null },
      '已开启 stdio 沙箱（STDIO_SANDBOX=bwrap），但平台服务所在的机器上找不到 bwrap。',
    ),
  ).toBe('');
  expect(connectionNextStep({ ...http, status: 'waiting_authorization' }, 'x')).toContain(
    '授权与账号',
  );
  const devices = new Map([['d1', { id: 'd1', name: '我的笔记本', online: false } as never]]);
  expect(connectionLocation(stdio, devices)).toBe('stdio · 我的笔记本（离线）');
  expect(connectionLocation({ ...http, url: 'https://x.test/mcp' }, devices)).toBe(
    'https://x.test/mcp',
  );
});

test('fixing an upstream address with form fields keeps hidden query secrets unless replaced', async () => {
  const account = await h.signup();
  const created = (await (
    await account.request('/connections', {
      method: 'POST',
      body: JSON.stringify({
        name: 'moved',
        adapter: 'direct',
        transport: 'http',
        mode: 'existing',
        url: 'http://127.0.0.1:1/mcp?api_key=query-secret',
      }),
    })
  ).json()) as { id: string };
  const row = async () =>
    (await (await account.request(`/connections/${created.id}`)).json()) as Row & {
      revision: number;
    };
  const before = await row();
  expect(before).toMatchObject({ url: 'http://127.0.0.1:1/mcp', urlHasQuery: true });
  expect(JSON.stringify(before)).not.toContain('query-secret');
  // Saving other fields without touching the address keeps the stored query string.
  await account.request(`/connections/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'moved (renamed)', revision: before.revision }),
  });
  expect((await h.services.connections.context(account.ownerId, created.id)).config.url).toBe(
    'http://127.0.0.1:1/mcp?api_key=query-secret',
  );
  const failed = await account.request(`/connections/${created.id}/discover`, { method: 'POST' });
  expect(failed.ok).toBe(false);
  // The form sends the new address, then connects in the same step.
  const after = await row();
  expect(
    (
      await account.request(`/connections/${created.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ url: upstream.url, revision: after.revision }),
      })
    ).status,
  ).toBe(200);
  const tools = (await (
    await account.request(`/connections/${created.id}/discover`, { method: 'POST' })
  ).json()) as { name: string }[];
  expect(tools.map((tool) => tool.name)).toContain('echo');
  expect(await row()).toMatchObject({ status: 'connected', urlHasQuery: false, error: null });
});

test('device tool command and arguments are editable without exposing sensitive arguments; offline is reported as such', async () => {
  const account = await h.signup();
  const pairing = await h.services.devices.createPairing(account.ownerId, '我的笔记本');
  const device = await h.services.devices.pair(pairing.code);
  const created = await h.services.connections.create(account.ownerId, {
    name: '笔记本 echo',
    adapter: 'device',
    deviceId: device.deviceId,
    transport: 'stdio',
    mode: 'managed',
    command: 'node',
    args: ['/workspace/echo.mjs', '--token', 'arg-secret'],
    sensitiveArguments: [2],
  });
  const read = async () =>
    (await (await account.request(`/connections/${created.id}`)).json()) as Row & {
      revision: number;
    };
  const before = await read();
  expect(before).toMatchObject({
    command: 'node',
    args: ['/workspace/echo.mjs', '--token', hiddenArgument],
    deviceOffline: true,
  });
  expect(JSON.stringify(before)).not.toContain('arg-secret');
  const patch = (args: string[], revision: number) =>
    account.request(`/connections/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ args, revision }),
    });
  const moved = await patch([hiddenArgument, '--token'], before.revision);
  expect(moved.status).toBe(400);
  expect(((await moved.json()) as { error: string }).error).toContain('位置变了');
  expect(
    (await patch(['/workspace/echo-v2.mjs', '--token', hiddenArgument, '--quiet'], before.revision))
      .status,
  ).toBe(200);
  expect((await h.services.connections.context(account.ownerId, created.id)).config.args).toEqual([
    '/workspace/echo-v2.mjs',
    '--token',
    'arg-secret',
    '--quiet',
  ]);
  const offline = await account.request(`/connections/${created.id}/discover`, { method: 'POST' });
  expect(offline.ok).toBe(false);
  const body = (await offline.json()) as { code: string; error: string };
  expect(body.code).toBe('DEVICE_OFFLINE');
  expect(body.error).toContain('「我的笔记本」离线');
  expect(body.error).not.toMatch(/检查服务地址|网络和凭据/);
  const after = await read();
  expect(after).toMatchObject({ deviceOffline: true, status: 'error' });
  expect(after.error).toContain('重新运行安装命令');
  expect(
    connectionNextStep(
      {
        ...after,
        adapter: 'device',
        transport: 'stdio',
        mode: 'managed',
        deviceId: device.deviceId,
      },
      body.error,
      body.code,
    ),
    // The server message already names the device and the fix, so no second hint is added.
  ).toBe('');
});
