import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { connections } from '../packages/db/src/index.js';
import { harness } from '../tests/harness.js';
import { fixtureMcp } from '../tests/fixtureMcp.js';
import { mountWeb } from '../apps/server/src/web.js';

const group = process.argv[2];
const width = Number(process.argv[3] ?? 1280);
assert.ok(group === 'flow' || group === 'settings', 'Choose flow or settings');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const upstream = await fixtureMcp();
const h = await harness();
await mountWeb(h.app, resolve('apps/web/dist'));
h.config.WEB_ORIGIN = h.baseURL;
const account = await h.signup();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width, height: width === 844 ? 390 : 844 },
  reducedMotion: width === 390 ? 'reduce' : 'no-preference',
  permissions: ['clipboard-read', 'clipboard-write'],
});
context.setDefaultTimeout(5000);
await context.addCookies(
  account.cookie.split('; ').map((pair) => ({
    name: pair.slice(0, pair.indexOf('=')),
    value: pair.slice(pair.indexOf('=') + 1),
    url: h.baseURL,
  })),
);
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(String(error)));
const screenshots = resolve('.data/onboarding-browser');
await mkdir(screenshots, { recursive: true });
const createConnection = (name: string) =>
  h.services.connections.create(account.ownerId, {
    name,
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
  });

async function flow() {
  const source = await createConnection('Setup service');
  const other = await createConnection('Other service');
  const [tool] = await h.services.connections.discover(account.ownerId, source.id);
  const [otherTool] = await h.services.connections.discover(account.ownerId, other.id);
  const existing = (await h.services.profiles.save(account.ownerId, {
    name: 'Existing Agent',
    toolIds: [otherTool!.id],
  }))!;
  let issued = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/profiles\/[^/]+\/keys$/.test(request.url())) issued++;
  });
  await page.goto(h.baseURL + '/connections');
  await page
    .getByRole('region', { name: 'Setup service', exact: true })
    .getByRole('link', { name: '给 Agent 授权', exact: true })
    .click();
  assert.equal(new URL(page.url()).searchParams.get('connectionId'), source.id);
  await page
    .getByRole('region', { name: '连接授权引导' })
    .getByText('为「Setup service」分配权限')
    .waitFor();
  await page
    .locator('.profile-row')
    .filter({ hasText: existing.name })
    .getByRole('button', { name: '分配权限', exact: true })
    .click();
  const edit = page.getByRole('dialog', { name: `编辑：${existing.name}`, exact: true });
  const selected = edit.locator(`input[name="toolId"][value="${tool!.id}"]`);
  await edit.getByRole('checkbox', { name: /echo Setup service/ }).check();
  assert.equal(await selected.isChecked(), true);
  assert.equal(
    await edit.locator(`input[name="toolId"][value="${otherTool!.id}"]`).isChecked(),
    true,
  );
  assert.equal(await edit.getByRole('checkbox', { name: /echo Other service/ }).count(), 0);
  await page.route(`**/api/v1/profiles/${existing.id}`, (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 503,
          json: { error: { message: 'permissions write unavailable' } },
        })
      : route.continue(),
  );
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  await edit.getByRole('alert').filter({ hasText: 'permissions write unavailable' }).waitFor();
  assert.equal(await selected.isChecked(), true);
  assert.equal(issued, 0);
  await page.unroute(`**/api/v1/profiles/${existing.id}`);
  await edit.getByRole('button', { name: '保存', exact: true }).click();
  const access = page.getByRole('dialog', { name: `接入 ${existing.name}`, exact: true });
  await access.getByRole('status').filter({ hasText: '权限已保存' }).waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === '接入客户端');
  const saved = await h.services.profiles.owned(account.ownerId, existing.id);
  assert.deepEqual(new Set(saved.toolIds), new Set([tool!.id, otherTool!.id]));
  assert.equal(issued, 0, 'Saving permissions must not issue a key automatically');
  await page.screenshot({ path: resolve(screenshots, `access-${width}.png`), fullPage: true });
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith(`/profiles/${existing.id}/keys`),
  );
  await access.getByRole('button', { name: '生成接入密钥', exact: true }).click();
  const key = await (await response).json();
  const issuedDialog = page.getByRole('dialog', { name: '接入密钥已生成', exact: true });
  await issuedDialog.getByRole('combobox', { name: '客户端', exact: true }).click();
  await page.getByRole('option', { name: 'generic-mcp-servers', exact: true }).click();
  await issuedDialog.getByRole('button', { name: '复制配置', exact: true }).click();
  await issuedDialog.getByText('已复制配置', { exact: true }).waitFor();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(clipboard.includes(`/mcp/${existing.id}`));
  assert.ok(clipboard.includes(key.token), 'Copy must contain the actual newly issued key');
  assert.equal(issued, 1);
  await issuedDialog.getByRole('link', { name: '以此 Agent 测试工具', exact: true }).click();
  await page.getByRole('heading', { name: '工具', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('profileId'), existing.id);
  assert.equal(new URL(page.url()).searchParams.get('connectionId'), source.id);
  assert.equal(upstream.count(), 0, 'Navigating to testing must not execute tools');
  await page.goto(`${h.baseURL}/profiles?connectionId=${source.id}`);
  await page.getByRole('button', { name: '新建 Agent', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建 Agent', exact: true });
  const name = create.getByLabel('配置名称', { exact: true });
  await name.waitFor();
  assert.equal(await name.inputValue(), 'Setup service Agent');
  assert.equal(await create.locator('input[name="toolId"]:checked').count(), 0);
  await name.fill('New setup Agent');
  await create.getByRole('checkbox', { name: /echo Setup service/ }).check();
  await create.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByRole('dialog', { name: '接入 New setup Agent', exact: true }).waitFor();
  assert.equal(issued, 1);
  await page
    .getByRole('dialog', { name: '接入 New setup Agent', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  for (let index = 0; index < 2; index++) {
    await page.getByRole('button', { name: '使用指南', exact: true }).click();
    await page.getByRole('link', { name: '配置 Agent', exact: true }).click();
    await create.waitFor();
    await create.getByRole('button', { name: '关闭', exact: true }).click();
    await create.waitFor({ state: 'detached' });
  }
}

async function settings() {
  const input = {
    name: 'Settings service',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
    connectTimeoutMs: 27000,
    requestOptions: { timeoutMs: 31000, resetTimeoutOnProgress: true, maxTotalTimeoutMs: 67000 },
    lifecycle: { startup: 'on-demand', idleTimeoutMs: 17000, shutdownGraceMs: 7000 },
    health: {
      enabled: false,
      intervalMs: 47000,
      timeoutMs: 9000,
      recover: false,
      initialIntervalMs: 11000,
      maxIntervalMs: 71000,
    },
    forwardHeaders: ['X-Audit'],
  };
  const source = await h.services.connections.create(account.ownerId, input);
  await page.goto(h.baseURL + '/connections');
  await page.getByRole('button', { name: 'Settings service 更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '编辑连接', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑连接', exact: true });
  await editor.getByLabel('连接名称', { exact: true }).fill('Renamed service');
  assert.equal(await editor.getByLabel('启动方式', { exact: true }).isVisible(), false);
  assert.equal(await editor.getByRole('button', { name: '手动检查更新', exact: true }).count(), 0);
  await page.screenshot({ path: resolve(screenshots, `settings-${width}.png`), fullPage: true });
  await editor.getByRole('button', { name: '保存设置', exact: true }).click();
  await editor.waitFor({ state: 'detached' });
  const saved = (await h.services.connections.context(account.ownerId, source.id)).config;
  for (const field of [
    'connectTimeoutMs',
    'requestOptions',
    'lifecycle',
    'health',
    'forwardHeaders',
  ] as const)
    assert.deepEqual(
      saved[field],
      input[field],
      `Collapsed advanced values must preserve ${field}`,
    );
  assert.equal(saved.name, 'Renamed service');
  await page.getByRole('button', { name: 'Renamed service 更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '编辑连接', exact: true }).click();
  await editor.getByRole('button', { name: '高级设置', exact: true }).click();
  const timeout = editor.getByLabel('连接初始化超时（秒）', { exact: true });
  await timeout.fill('0');
  await editor.getByRole('button', { name: '高级设置', exact: true }).click();
  await editor.getByRole('button', { name: '保存设置', exact: true }).click();
  await timeout.waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('name') === 'connectTimeout',
  );
  await editor.getByLabel('连接初始化超时（秒）', { exact: true }).fill('28');
  await editor.getByRole('button', { name: '高级设置', exact: true }).click();
  await editor.getByRole('button', { name: '关闭', exact: true }).click();
  await page
    .getByRole('dialog', { name: '放弃未保存的修改？', exact: true })
    .getByRole('button', { name: '放弃修改并继续', exact: true })
    .click();
  await editor.waitFor({ state: 'detached' });
  assert.equal(
    (await h.services.connections.context(account.ownerId, source.id)).config.connectTimeoutMs,
    27000,
  );
  await h.db
    .update(connections)
    .set({ status: 'waiting_authorization', error: 'OAuth authorization required' })
    .where(eq(connections.id, source.id));
  await page.reload();
  const row = page.getByRole('region', { name: 'Renamed service', exact: true });
  await row.getByText('等待账号授权', { exact: true }).first().waitFor();
  await row.getByRole('button', { name: '授权与账号', exact: true }).waitFor();
  await row.getByText('OAuth authorization required', { exact: true }).waitFor();
  await row.getByText('打开“授权与账号”完成授权，再连接读取工具目录。', { exact: true }).waitFor();
  const unavailable = await fixtureMcp();
  const unavailableUrl = unavailable.url;
  await unavailable.close();
  const broken = await h.services.connections.create(account.ownerId, {
    name: 'Unavailable service',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: unavailableUrl,
  });
  await assert.rejects(() => h.services.connections.discover(account.ownerId, broken.id));
  const failure = (await h.services.connections.list(account.ownerId)).find(
    (connection) => connection.id === broken.id,
  )!.error;
  assert.ok(failure);
  await page.reload();
  const failed = page.getByRole('region', { name: 'Unavailable service', exact: true });
  await failed.getByRole('alert').getByText(failure, { exact: true }).waitFor();
  await failed.getByRole('button', { name: '编辑连接', exact: true }).waitFor();
  await failed.getByRole('button', { name: '重试', exact: true }).waitFor();
  await page.getByRole('button', { name: '使用指南', exact: true }).click();
  await page.getByRole('link', { name: '选择服务', exact: true }).click();
  const add = page.getByRole('dialog', { name: '添加连接', exact: true });
  await add.waitFor();
  await add.getByRole('button', { name: '关闭', exact: true }).click();
  await add.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '使用指南', exact: true }).click();
  await page.getByRole('link', { name: '选择服务', exact: true }).click();
  await add.waitFor();
}

try {
  await (group === 'flow' ? flow() : settings());
  assert.deepEqual(errors, []);
  assert.equal(upstream.count(), 0);
  console.log(`PASS: onboarding ${group} at ${width}px, no automatic business calls`);
} finally {
  await context.close();
  await browser.close();
  await h.close();
  await upstream.close();
}
