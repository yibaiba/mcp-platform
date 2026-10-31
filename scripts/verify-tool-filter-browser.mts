import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { user } from '../packages/db/src/index.js';
import { hiddenValue } from '../packages/contracts/src/index.js';
import { harness } from '../tests/harness.js';
import { fixtureMcp } from '../tests/fixtureMcp.js';
import { mountWeb } from '../apps/server/src/web.js';
import type { Locator, Page } from 'playwright';

// Safety labels and bulk selection in the share and Agent pickers; env / header key-value editors.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const screenshots = process.env.SCREENSHOT_DIR;
const schema = { type: 'object', properties: {} };
const upstream = await fixtureMcp({
  extraTools: [
    { name: 'list_rows', inputSchema: schema, annotations: { readOnlyHint: true } },
    { name: 'append_row', inputSchema: schema, annotations: { destructiveHint: false } },
    { name: 'drop_table', inputSchema: schema, annotations: { destructiveHint: true } },
  ],
});
const h = await harness();
await mountWeb(h.app, resolve('apps/web/dist'));
h.config.WEB_ORIGIN = h.baseURL;
const admin = await h.signup();
await h.db.update(user).set({ role: 'admin' }).where(eq(user.id, admin.ownerId));
const member = await h.signup();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function pageFor(account: typeof admin) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(5000);
  await context.addCookies(
    account.cookie.split('; ').map((pair) => ({
      name: pair.slice(0, pair.indexOf('=')),
      value: pair.slice(pair.indexOf('=') + 1),
      url: h.baseURL,
    })),
  );
  return context.newPage();
}
const shot = async (page: Page, name: string) => {
  if (screenshots) await page.screenshot({ path: resolve(screenshots, `${name}.png`) });
};
const checked = (scope: Locator) =>
  scope.locator('[data-tool]').evaluateAll((rows) =>
    rows
      .filter((row) => row.querySelector('[aria-checked="true"]'))
      .map((row) => (row as HTMLElement).dataset.tool!)
      .sort(),
  );
const SECRET = 'Bearer browser-filter-secret';

try {
  const source = await h.services.connections.create(admin.ownerId, {
    name: 'Filter source',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
    // Stored values must load masked and save back unchanged.
    headers: { Authorization: SECRET, 'X-Legacy': 'kept' },
  });
  const tools = await h.services.connections.discover(admin.ownerId, source.id);
  const idOf = (name: string) => tools.find((tool) => tool.name === name)!.id;

  // --- admin: share with every member, read-only first, then "排除破坏性" ---
  const page = await pageFor(admin);
  await page.goto(h.baseURL + '/connections');
  await page.getByRole('button', { name: 'Filter source 更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '共享连接', exact: true }).click();
  const team = page.getByRole('region', { name: '共享给所有成员' });
  const toolbar = team.getByTestId('tool-safety');
  await toolbar.waitFor();
  assert.deepEqual(await team.locator('[data-safety]').allTextContents(), [
    '未声明',
    '只读',
    '会修改（非破坏性）',
    '破坏性',
  ]);
  await toolbar.getByText(/1 个工具「未声明」/).waitFor();
  await toolbar.getByRole('button', { name: '只选只读', exact: true }).click();
  assert.deepEqual(await checked(team), ['list_rows']);
  await toolbar.getByRole('status').filter({ hasText: '已只选 1 个只读工具' }).waitFor();
  await toolbar.getByRole('button', { name: '全选', exact: true }).click();
  assert.deepEqual(await checked(team), ['append_row', 'drop_table', 'echo', 'list_rows']);
  await toolbar.getByRole('button', { name: '排除破坏性', exact: true }).click();
  // The undeclared tool goes with the destructive one.
  assert.deepEqual(await checked(team), ['append_row', 'list_rows']);
  await toolbar
    .getByRole('status')
    .filter({ hasText: '已取消 2 个破坏性或未声明的工具' })
    .waitFor();
  // The filter only hides rows; hidden selected rows are still submitted.
  await toolbar.getByRole('button', { name: '未声明 1', exact: true }).click();
  assert.equal(await team.locator('[data-tool]:visible').count(), 1);
  await shot(page, 'b01-team-filter-undeclared');
  await toolbar.getByRole('button', { name: '只读 1', exact: true }).click();
  await shot(page, 'b02-team-filter-readonly');
  await team.getByRole('combobox').click();
  await page.getByRole('option', { name: '所有成员使用我的凭证' }).click();
  await team.getByRole('button', { name: '共享给所有成员', exact: true }).click();
  await team.getByText(/生效中 · \d+ 人可用/).waitFor();
  const teamShare = (await (
    await admin.request(`/connections/${source.id}/team-share`)
  ).json()) as {
    toolIds: string[];
  };
  assert.deepEqual(teamShare.toolIds.sort(), [idOf('append_row'), idOf('list_rows')].sort());
  // The individual share form has the same toolbar.
  assert.equal(await page.getByTestId('tool-safety').count(), 2);
  await page.keyboard.press('Escape');

  // --- member: new Agent from the shared connection, then "只选只读" ---
  const memberPage = await pageFor(member);
  await memberPage.goto(h.baseURL + '/connections');
  await memberPage.getByRole('button', { name: '查看', exact: true }).click();
  await memberPage.getByRole('dialog').getByRole('link', { name: '新建 Agent' }).click();
  const editor = memberPage.getByRole('dialog');
  const memberBar = editor.getByTestId('tool-safety');
  await memberBar.waitFor();
  // A new Agent starts with every shared tool checked.
  assert.deepEqual(await checked(editor), ['append_row', 'list_rows']);
  await memberBar.getByRole('button', { name: '只选只读', exact: true }).click();
  assert.deepEqual(await checked(editor), ['list_rows']);
  await shot(memberPage, 'b03-member-agent-readonly');
  const created = memberPage.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/v1/profiles'),
  );
  await editor.getByRole('button', { name: /^创建/ }).click();
  const profile = (await (await created).json()) as { toolIds: string[] };
  assert.equal(profile.toolIds.length, 1);

  // --- key-value editor: create a connection with headers ---
  await page.goto(h.baseURL + '/connections');
  await page.getByRole('button', { name: '添加连接' }).first().click();
  await page.getByRole('tab', { name: '自定义', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('连接名称', { exact: true }).fill('Form headers');
  await sheet.getByLabel('MCP 地址', { exact: true }).fill(upstream.url);
  await sheet.getByRole('button', { name: '请求头', exact: true }).click();
  const kv = sheet.getByTestId('kv-headers');
  await kv.getByRole('button', { name: '添加请求头', exact: true }).click();
  await kv.getByLabel('请求头第 1 行名称', { exact: true }).fill('Bad Header');
  await kv.getByRole('alert').filter({ hasText: '不能有空格' }).waitFor();
  await kv.getByLabel('请求头第 1 行名称', { exact: true }).fill('Authorization');
  await kv.getByLabel('请求头第 1 行的值', { exact: true }).fill('Bearer typed-secret');
  // Sensitive-looking keys are masked while typing, with a reveal toggle.
  assert.equal(
    await kv.getByLabel('请求头第 1 行的值', { exact: true }).getAttribute('type'),
    'password',
  );
  await kv.getByRole('button', { name: '显示', exact: true }).click();
  assert.equal(
    await kv.getByLabel('请求头第 1 行的值', { exact: true }).getAttribute('type'),
    'text',
  );
  await kv.getByRole('button', { name: '隐藏', exact: true }).click();
  await kv.getByRole('button', { name: '添加请求头', exact: true }).click();
  await kv.getByLabel('请求头第 2 行名称', { exact: true }).fill('authorization');
  await kv.getByRole('alert').filter({ hasText: '和第 1 行重名' }).waitFor();
  await kv.getByLabel('请求头第 2 行名称', { exact: true }).fill('X-Plain');
  await kv.getByLabel('请求头第 2 行的值', { exact: true }).fill('plain');
  assert.equal(
    await kv.getByLabel('请求头第 2 行的值', { exact: true }).getAttribute('type'),
    'text',
  );
  await shot(page, 'b04-create-headers-form');
  await kv.getByRole('button', { name: '切换到原始模式', exact: true }).click();
  const raw = kv.getByLabel('请求头（原始）', { exact: true });
  assert.deepEqual(JSON.parse(await raw.inputValue()), {
    Authorization: 'Bearer typed-secret',
    'X-Plain': 'plain',
  });
  await raw.fill('Authorization: Bearer typed-secret\nX-Plain: plain\nX-Raw: from raw');
  await kv.getByRole('button', { name: '切换回表单', exact: true }).click();
  assert.equal(await kv.getByLabel('请求头第 3 行名称', { exact: true }).inputValue(), 'X-Raw');
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/v1/connections'),
  );
  await sheet.getByRole('button', { name: '保存并连接', exact: true }).click();
  const createdConnection = (await (await saved).json()) as { id: string };
  assert.deepEqual(
    (await h.services.connections.context(admin.ownerId, createdConnection.id)).config.headers,
    { Authorization: 'Bearer typed-secret', 'X-Plain': 'plain', 'X-Raw': 'from raw' },
  );

  // --- key-value editor: an existing config reads in masked and saves back unchanged ---
  const openEdit = async () => {
    await page.goto(h.baseURL + '/connections');
    await page.getByRole('button', { name: 'Filter source 更多操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '编辑连接', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '编辑连接', exact: true });
    await dialog.getByRole('button', { name: '请求头 2 项', exact: true }).click();
    return dialog;
  };
  let dialog = await openEdit();
  const stored = dialog.getByTestId('kv-headers');
  assert.equal(await stored.getByText('••••••（已保存，不改则保留）').count(), 2);
  assert.equal(await page.getByText(SECRET).count(), 0);
  await shot(page, 'b05-edit-headers-masked');
  await dialog.getByLabel('连接名称', { exact: true }).fill('Filter source');
  await dialog.getByRole('button', { name: '保存并连接', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(
    (await h.services.connections.context(admin.ownerId, source.id)).config.headers,
    {
      Authorization: SECRET,
      'X-Legacy': 'kept',
    },
  );
  // Raw mode shows placeholders, and leaving them keeps the stored values.
  dialog = await openEdit();
  await stored.getByRole('button', { name: '切换到原始模式', exact: true }).click();
  assert.deepEqual(JSON.parse(await stored.getByLabel('请求头（原始）').inputValue()), {
    Authorization: hiddenValue,
    'X-Legacy': hiddenValue,
  });
  await stored.getByRole('button', { name: '切换回表单', exact: true }).click();
  // Replace one value, delete the legacy row, add a row.
  await stored.getByRole('button', { name: '替换值', exact: true }).first().click();
  await stored.getByLabel('请求头第 1 行的值', { exact: true }).fill('Bearer replaced');
  await stored.getByRole('button', { name: '删除请求头第 2 行', exact: true }).click();
  await stored.getByRole('button', { name: '添加请求头', exact: true }).click();
  await stored.getByLabel('请求头第 2 行名称', { exact: true }).fill('X-Added');
  await stored.getByLabel('请求头第 2 行的值', { exact: true }).fill('added');
  await dialog.getByRole('button', { name: '保存并连接', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(
    (await h.services.connections.context(admin.ownerId, source.id)).config.headers,
    {
      Authorization: 'Bearer replaced',
      'X-Added': 'added',
    },
  );
  console.log('tool filter and key-value browser checks passed');
} finally {
  await browser.close();
  await h.close();
  await upstream.close();
}
