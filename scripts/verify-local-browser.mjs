import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { harness } from '../tests/harness.ts';
import { fixtureMcp } from '../tests/fixtureMcp.ts';
import { createServer } from '../apps/web/node_modules/vite/dist/node/index.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const webOrigin = 'http://localhost:54931';
const h = await harness({ webOrigin });
const mcp = await fixtureMcp();
const account = await h.signup();
let connector;
let vite;
let browser;
let platform;
const screenshots = resolve('.data/local-browser-acceptance');
await mkdir(screenshots, { recursive: true });
const configPath = join(h.directory, '.cursor', 'mcp.json');
await mkdir(join(h.directory, '.cursor'), { recursive: true });
await writeFile(
  configPath,
  `{// keep this comment\n"theme":"untouched","mcpServers":{"browser-mcp":{"type":"http","url":${JSON.stringify(mcp.url)},"headers":{"Authorization":"Bearer browser-private-credential"},"description":"offline original"}}}`,
);
await mkdir(join(h.directory, '.agents', 'skills', 'browser-skill'), { recursive: true });
await writeFile(
  join(h.directory, '.agents', 'skills', 'browser-skill', 'SKILL.md'),
  '---\nname: browser-skill\ndescription: Browser test skill\n---\nOriginal content\n',
);
async function start(args) {
  connector = spawn(
    resolve('connector/bin/connector'),
    [...args, '--data-dir', join(h.directory, 'local-state')],
    {
      env: {
        ...process.env,
        HOME: h.directory,
        CODEX_HOME: join(h.directory, '.codex'),
        PI_CODING_AGENT_DIR: join(h.directory, '.pi', 'agent'),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error(`Connector startup timed out: ${output}`)),
      10000,
    );
    connector.once('error', reject);
    connector.once('exit', (code) => {
      if (code) reject(new Error(`Connector exited ${code}: ${output}`));
    });
    connector.stderr.on('data', (chunk) => {
      output += chunk;
      const url = /http:\/\/127\.0\.0\.1:\d+\/#open=[a-f0-9]+/.exec(output)?.[0];
      if (url) {
        clearTimeout(timeout);
        resolve(url);
      }
    });
  });
}
async function stop() {
  if (!connector || connector.exitCode !== null) return;
  const exited = new Promise((resolve) => connector.once('exit', resolve));
  connector.kill('SIGINT');
  await exited;
}
async function until(read, predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await pause(100);
  }
  throw new Error(message);
}
const errors = [];
// Device actions live in each device row's ⋯ menu.
async function deviceMenuAction(name) {
  await platform
    .getByRole('button', { name: /更多操作$/ })
    .first()
    .click();
  await platform.getByRole('menuitem', { name, exact: true }).click();
}
try {
  const localURL = await start(['manage']);
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
  });
  // Only loopback requests are allowed in this acceptance run. No CDN is needed.
  await context.route('**/*', (route) =>
    ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  );
  const local = await context.newPage();
  local.on('pageerror', (error) => errors.push(String(error)));
  await local.goto(localURL);
  await local.getByRole('heading', { name: '本机 MCP 与 Skills' }).waitFor();
  assert.equal(await local.locator('select').count(), 0);
  await local.locator('.local-sources > summary').click();
  await local.getByRole('combobox', { name: '客户端', exact: true }).click();
  await local.getByRole('option', { name: 'Claude Code', exact: true }).click();
  await local.getByRole('combobox', { name: '资源类型', exact: true }).click();
  await local.getByRole('option', { name: 'Skills 根目录', exact: true }).click();
  await local.locator('.local-sources > summary').click();
  await local.getByRole('button', { name: 'browser-mcp offline original' }).click();
  await local.getByRole('button', { name: '由连接器连接', exact: true }).click();
  await until(
    () => local.getByText('连接成功', { exact: true }).count(),
    (value) => value > 0,
    'Local MCP did not connect',
  );
  await local.getByRole('button', { name: '停止连接器会话', exact: true }).click();
  await until(
    () => local.getByText('由客户端管理', { exact: true }).count(),
    (value) => value > 0,
    'Owned session did not stop',
  );
  const editor = local.getByLabel('所选 MCP 条目（JSON）');
  let content = JSON.parse(await editor.inputValue());
  content.description = 'offline browser edit';
  await editor.fill(JSON.stringify(content, null, 2));
  await local.getByRole('button', { name: '保存修改', exact: true }).click();
  await until(
    () => readFile(configPath, 'utf8'),
    (value) => value.includes('offline browser edit'),
    'Offline edit was not saved',
  );
  assert.ok((await readFile(configPath, 'utf8')).includes('// keep this comment'));
  await local.getByRole('checkbox', { name: '纳入此设备与来源同步', exact: true }).click();
  await until(
    () => local.getByRole('checkbox', { name: '纳入此设备与来源同步', exact: true }).isChecked(),
    (value) => value,
    'Selection was not saved',
  );
  await local.getByRole('tab', { name: 'Skills', exact: true }).click();
  await local.getByRole('button', { name: 'browser-skill Browser test skill' }).click();
  await local.getByRole('combobox', { name: '文件树', exact: true }).click();
  await local.getByRole('option', { name: 'SKILL.md', exact: true }).click();
  await local
    .getByLabel('SKILL.md', { exact: true })
    .fill('---\nname: browser-skill\ndescription: Browser test skill\n---\nEdited offline\n');
  await local.getByRole('button', { name: '保存修改', exact: true }).click();
  await until(
    () => readFile(join(h.directory, '.agents', 'skills', 'browser-skill', 'SKILL.md'), 'utf8'),
    (value) => value.includes('Edited offline'),
    'Skill edit missing',
  );
  await local.getByRole('checkbox', { name: '纳入此设备与来源同步', exact: true }).click();
  await until(
    () => local.getByRole('checkbox', { name: '纳入此设备与来源同步', exact: true }).isChecked(),
    (value) => value,
    'Selection was not saved',
  );
  await local.getByText('切换内容版本', { exact: true }).click();
  await local.getByRole('button', { name: '读取历史版本', exact: true }).click();
  const versions = local.getByLabel('内容版本', { exact: true });
  await versions.click();
  await local.getByRole('option').nth(1).click();
  await local.getByRole('button', { name: '载入编辑器', exact: true }).click();
  await until(
    () => local.getByLabel('SKILL.md', { exact: true }).inputValue(),
    (value) => value.includes('Original content'),
    'Historical Skill content not loaded',
  );
  await local.getByRole('button', { name: '保存修改', exact: true }).click();
  await until(
    () => readFile(join(h.directory, '.agents', 'skills', 'browser-skill', 'SKILL.md'), 'utf8'),
    (value) => value.includes('Original content'),
    'Version switch not saved',
  );
  await local.screenshot({ path: join(screenshots, 'local-desktop.png'), fullPage: true });
  await local.setViewportSize({ width: 375, height: 812 });
  assert.equal(
    await local.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'Local UI overflows narrow viewport',
  );
  await local.screenshot({ path: join(screenshots, 'local-narrow.png'), fullPage: true });
  await local.getByRole('searchbox').fill('not-present');
  await local.getByText('没有匹配资源。可添加项目或配置目录，然后重新扫描。').waitFor();
  await local.getByRole('searchbox').fill('');
  await local.getByRole('searchbox').press('Tab');
  assert.equal(mcp.count(), 0, 'Scanning or editing dispatched a tool');
  await stop();
  const pairing = await h.services.devices.createPairing(account.ownerId, 'Browser workstation');
  const device = await h.services.devices.pair(pairing.code);
  const pairedPath = join(h.directory, 'connector.json');
  await writeFile(pairedPath, JSON.stringify({ server: h.baseURL, ...device }), { mode: 0o600 });
  const pairedURL = await start(['manage', '--offline=false', '--config', pairedPath]);
  await until(
    () => h.services.local.repository.list(account.ownerId, device.deviceId),
    (rows) => rows.length === 2 && rows.every((row) => row.status === 'synced'),
    'Offline selections did not synchronize after pairing',
  );
  vite = await createServer({
    root: resolve('apps/web'),
    configFile: resolve('apps/web/vite.config.ts'),
    server: { host: 'localhost', port: 54931, strictPort: true, proxy: { '/api': h.baseURL } },
  });
  await vite.listen();
  await context.addCookies(
    account.cookie.split('; ').map((part) => ({
      name: part.slice(0, part.indexOf('=')),
      value: part.slice(part.indexOf('=') + 1),
      url: webOrigin,
    })),
  );
  platform = await context.newPage();
  platform.on('pageerror', (error) => errors.push(String(error)));
  await platform.goto(`${webOrigin}/devices`);
  // Dev-style split origins: the copied installer must target PUBLIC_URL, with a visible notice.
  await platform.getByRole('button', { name: '添加设备', exact: true }).first().click();
  await platform.locator('[data-origin-mismatch]').waitFor();
  const installer = (await platform.locator('pre').allTextContents()).join('\n');
  assert.ok(installer.includes(`'${h.baseURL}/api/v1/connector/install.sh'`), installer);
  assert.ok(installer.includes(`--server '${h.baseURL}'`), installer);
  assert.ok(!installer.includes(webOrigin), installer);
  await platform.screenshot({ path: join(screenshots, 'installer-origin-notice.png') });
  await platform.keyboard.press('Escape');
  await deviceMenuAction('管理本机 MCP / Skills');
  await platform.getByRole('button', { name: 'browser-mcp offline browser edit' }).click();
  const remoteEditor = platform.getByLabel('所选 MCP 条目（JSON）');
  assert.ok(!(await remoteEditor.inputValue()).includes('browser-private-credential'));
  content = JSON.parse(await remoteEditor.inputValue());
  content.description = 'platform browser edit';
  await remoteEditor.fill(JSON.stringify(content, null, 2));
  await platform.getByRole('button', { name: '保存修改', exact: true }).click();
  await until(
    () => readFile(configPath, 'utf8'),
    (value) => value.includes('platform browser edit'),
    'Platform edit did not reach local file',
  );
  await until(
    () => h.services.local.repository.list(account.ownerId, device.deviceId),
    (rows) => rows.every((row) => row.status === 'synced'),
    'Writeback did not settle to synced',
  );
  const rows = await h.services.local.repository.list(account.ownerId, device.deviceId);
  const binding = rows.find((r) => r.metadata.kind === 'mcp');
  await h.services.local.mutateBinding(account.ownerId, {
    deviceId: device.deviceId,
    id: binding.id,
    revision: binding.revision,
    operationId: randomUUID(),
    action: 'update',
    content: { ...binding.content, description: 'platform conflict choice' },
  });
  await writeFile(
    configPath,
    (await readFile(configPath, 'utf8')).replace('platform browser edit', 'local conflict choice'),
  );
  const snapshot = await h.services.local.sync.state(device.deviceId);
  await h.services.local.request(account.ownerId, device.deviceId, {
    action: 'scan',
    expectedRevision: snapshot.revision,
    operationId: randomUUID(),
  });
  await platform.getByRole('button', { name: '采用平台', exact: true }).waitFor({ timeout: 15000 });
  await platform.getByRole('button', { name: '采用平台', exact: true }).click();
  await until(
    () => readFile(configPath, 'utf8'),
    (value) => value.includes('platform conflict choice'),
    'Conflict resolution failed',
  );
  await until(
    () => h.services.local.repository.list(account.ownerId, device.deviceId),
    (rows) => rows.every((row) => row.status === 'synced'),
    'Conflict did not settle to synced',
  );
  await platform.getByRole('button', { name: '重新载入来源', exact: true }).click();
  await platform.screenshot({ path: join(screenshots, 'platform-desktop.png'), fullPage: true });
  await platform.setViewportSize({ width: 375, height: 812 });
  assert.equal(
    await platform.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'Platform UI overflows narrow viewport',
  );
  await platform.screenshot({ path: join(screenshots, 'platform-narrow.png'), fullPage: true });
  await local.goto(pairedURL);
  await local.getByRole('tab', { name: '同步记录' }).click();
  await local.getByRole('button', { name: '恢复此修改前的副本' }).first().waitFor();
  await local.getByRole('button', { name: '恢复此修改前的副本' }).first().click();
  await until(
    () => readFile(configPath, 'utf8'),
    (value) => value.includes('local conflict choice'),
    'History recovery did not restore the previous content',
  );
  await until(
    () => h.services.local.repository.list(account.ownerId, device.deviceId),
    (rows) =>
      rows.every((row) => row.status === 'synced') &&
      rows.some(
        (row) =>
          row.metadata.kind === 'mcp' && row.baseline.description === 'local conflict choice',
      ),
    'Restored content did not synchronize before re-pair',
  );
  const beforeRePair = await h.services.local.repository.list(account.ownerId, device.deviceId);
  await platform.setViewportSize({ width: 1280, height: 900 });
  // Re-pair is a device-list action, so leave the per-device manager view.
  await platform.goto(`${webOrigin}/devices`);
  await deviceMenuAction('重新配对');
  await platform.getByText('生成重配码会立即断开此设备', { exact: false }).first().waitFor();
  await platform.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(h.services.broker.online(device.deviceId), true);
  await deviceMenuAction('重新配对');
  const rePairResponse = platform.waitForResponse(
    (response) =>
      response.url().endsWith(`/devices/${device.deviceId}/re-pairings`) &&
      response.request().method() === 'POST',
  );
  await platform.getByRole('button', { name: '确认断线并生成重配码', exact: true }).click();
  const { code: rePairCode } = await (await rePairResponse).json();
  await platform
    .getByText(
      `connector re-pair --config connector.json --server ${h.baseURL} --device-id ${device.deviceId}`,
      { exact: true },
    )
    .waitFor();
  await platform.getByText('待重新配对', { exact: true }).waitFor();
  assert.equal(h.services.broker.online(device.deviceId), false);
  await platform.screenshot({
    path: join(screenshots, 'device-re-pair-pending.png'),
    fullPage: true,
  });
  await stop();
  const rePairProcess = spawn(
    resolve('connector/bin/connector'),
    ['re-pair', '--config', pairedPath],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let rePairOutput = '';
  rePairProcess.stderr.on('data', (chunk) => {
    rePairOutput += chunk;
  });
  rePairProcess.stdin.end(`${rePairCode}\n`);
  const rePairExit = await new Promise((resolve, reject) => {
    rePairProcess.once('error', reject);
    rePairProcess.once('exit', resolve);
  });
  assert.equal(rePairExit, 0, rePairOutput);
  const newConfig = JSON.parse(await readFile(pairedPath, 'utf8'));
  assert.equal(newConfig.deviceId, device.deviceId);
  assert.equal(newConfig.credentialVersion, device.credentialVersion + 1);
  assert.ok(!rePairOutput.includes(newConfig.deviceSecret));
  await start(['manage', '--offline=false', '--config', pairedPath]);
  await until(
    () => h.services.broker.hasCapability(device.deviceId, 'local-sync'),
    Boolean,
    'Re-paired connector did not authenticate',
  );
  await platform.reload();
  await platform.getByText('在线', { exact: true }).waitFor();
  const afterRePair = await h.services.local.repository.list(account.ownerId, device.deviceId);
  assert.deepEqual(
    afterRePair.map((row) => row.id).sort(),
    beforeRePair.map((row) => row.id).sort(),
  );
  for (const row of afterRePair)
    assert.deepEqual(
      row.baseline,
      beforeRePair.find((previous) => previous.id === row.id).baseline,
    );
  await platform.screenshot({
    path: join(screenshots, 'device-re-pair-online.png'),
    fullPage: true,
  });
  assert.equal(mcp.count(), 0);
  await platform.setViewportSize({ width: 1440, height: 1000 });
  const sshConnection = await h.services.connections.create(account.ownerId, {
    name: 'SSH browser fixture',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: mcp.url,
  });
  // SSH access is its own tab on the devices page.
  await platform.goto(`${webOrigin}/devices?tab=ssh`);
  await platform.getByRole('button', { name: '新增 SSH 接入', exact: true }).click();
  await platform.getByLabel('接入名称', { exact: true }).fill('Browser SSH');
  await platform.getByLabel('SSH 主机', { exact: true }).fill('browser-ssh.example.test');
  await platform.getByLabel('SSH 用户', { exact: true }).fill('mcp');
  await platform.getByRole('combobox', { name: '映射 1 的 MCP 连接', exact: true }).click();
  await platform.getByRole('option', { name: 'SSH browser fixture', exact: true }).click();
  await platform.getByLabel('映射 1 的远端端口', { exact: true }).fill(new URL(mcp.url).port);
  await platform.getByRole('button', { name: '添加 SSH 接入', exact: true }).click();
  await platform.getByText('Browser SSH', { exact: true }).waitFor();
  await platform.getByText('隧道状态未上报', { exact: true }).waitFor();
  const download = platform.waitForEvent('download');
  await platform.getByRole('button', { name: '下载 Windows 连接包', exact: true }).click();
  const bundle = await download;
  assert.match(bundle.suggestedFilename(), /^mcp-platform-ssh-.*\.zip$/);
  assert.equal(await bundle.failure(), null);
  await platform.getByRole('button', { name: '编辑接入', exact: true }).click();
  const sshRecords = await (await account.request('/ssh-accesses')).json();
  const sshRecord = sshRecords[0];
  const {
    id: sshId,
    revision: sshRevision,
    services: _services,
    tunnelStatus: _status,
    ...sshConfig
  } = sshRecord;
  const changed = await account.request(`/ssh-accesses/${sshId}`, {
    method: 'PUT',
    body: JSON.stringify({
      ...sshConfig,
      revision: sshRevision,
      name: 'Browser SSH updated elsewhere',
    }),
  });
  assert.equal(changed.status, 200);
  // Real discovery invalidates the UI query while the editor must retain its old revision.
  await platform.getByRole('button', { name: '发现 MCP', exact: true }).click();
  await platform.getByText('Browser SSH updated elsewhere', { exact: true }).waitFor();
  await platform.getByRole('button', { name: '保存 SSH 接入', exact: true }).click();
  await platform.getByRole('alert').filter({ hasText: 'SSH 接入已变化' }).waitFor();
  await platform.getByRole('button', { name: '编辑接入', exact: true }).click();
  await platform.getByRole('button', { name: '编辑接入', exact: true }).click();
  await platform.getByLabel('接入名称', { exact: true }).fill('Browser SSH');
  await platform.getByLabel('断线重连间隔（秒）', { exact: true }).fill('7');
  await platform.screenshot({ path: join(screenshots, 'ssh-editor.png'), fullPage: true });
  await platform.getByRole('button', { name: '保存 SSH 接入', exact: true }).click();
  await platform.getByLabel('断线重连间隔（秒）', { exact: true }).waitFor({ state: 'detached' });
  await platform.setViewportSize({ width: 375, height: 812 });
  assert.equal(
    await platform.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'SSH UI overflows narrow viewport',
  );
  await platform.screenshot({ path: join(screenshots, 'ssh-narrow.png'), fullPage: true });
  await platform.getByRole('button', { name: '删除接入', exact: true }).click();
  await platform.getByRole('button', { name: '确认删除记录', exact: true }).click();
  await platform.getByText('Browser SSH', { exact: true }).waitFor({ state: 'detached' });
  assert.ok(await h.services.connections.owned(account.ownerId, sshConnection.id));
  assert.deepEqual(errors, []);
  console.log(
    'PASS: standalone offline editor, MCP/Skill selection, persisted pairing, platform writeback, conflict resolution, recovery UI, keyboard and 375px layouts, re-pair confirmation, pending state and real Go recovery with preserved MCP/Skill bindings; SSH create/edit/bundle/delete UI; no business calls',
  );
} catch (error) {
  if (browser)
    for (const context of browser.contexts())
      for (const [index, page] of context.pages().entries())
        await page
          .screenshot({ path: join(screenshots, `failure-${index}.png`), fullPage: true })
          .catch(() => undefined);
  throw error;
} finally {
  if (browser) await Promise.all(browser.contexts().map((context) => context.close()));
  await browser?.close();
  await vite?.close();
  await stop();
  await h.close();
  await mcp.close();
}
