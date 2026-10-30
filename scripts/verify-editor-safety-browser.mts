import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { user, networkConfiguration } from '../packages/db/src/index.js';
import { harness } from '../tests/harness.js';
import { fixtureMcp } from '../tests/fixtureMcp.js';
import { mountWeb } from '../apps/server/src/web.js';

// Run each group against an isolated migrated database; drafts writes platform settings.
const group = process.argv[2];
assert.ok(
  ['profiles', 'tasks', 'drafts'].includes(group ?? ''),
  'Choose profiles, tasks or drafts',
);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const upstream = await fixtureMcp();
const h = await harness();
await mountWeb(h.app, resolve('apps/web/dist'));
h.config.WEB_ORIGIN = h.baseURL;
const account = await h.signup();
await h.db.update(user).set({ role: 'admin' }).where(eq(user.id, account.ownerId));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
context.setDefaultTimeout(5000);
await context.addCookies(
  account.cookie.split('; ').map((pair) => ({
    name: pair.slice(0, pair.indexOf('=')),
    value: pair.slice(pair.indexOf('=') + 1),
    url: h.baseURL,
  })),
);
const page = await context.newPage();
const failure = (message: string) => ({
  status: 503,
  contentType: 'application/json',
  body: JSON.stringify({ error: { message } }),
});
const discard = () => page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true });
const navigateConnections = () =>
  page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '连接', exact: true })
    .click();
async function connection() {
  return h.services.connections.create(account.ownerId, {
    name: 'Safety connection',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: upstream.url,
  });
}
async function openProfile(name: string) {
  await page
    .locator('.profile-row')
    .filter({ hasText: name })
    .getByRole('button', { name: '编辑权限', exact: true })
    .click();
}
async function profiles() {
  const connected = await connection();
  const [tool] = await h.services.connections.discover(account.ownerId, connected.id);
  const toolId = tool!.id;
  const content = await h.services.library.save(account.ownerId, {
    kind: 'prompt',
    value: { name: 'safety-prompt', template: 'Hello' },
  });
  const skill = (await h.services.skills.import(account.ownerId, {
    source: 'browser-test',
    package: {
      name: 'safety-skill',
      files: {
        'SKILL.md': Buffer.from(
          '---\nname: safety-skill\ndescription: Safety test\n---\nRead only.',
        ).toString('base64'),
      },
    },
  }))!;
  const data = Buffer.from('original artifact');
  const artifact = await h.services.artifacts.upload(account.ownerId, {
    name: 'safety-artifact',
    sha256: createHash('sha256').update(data).digest('hex'),
    body: new Response(data).body,
  });
  const grants = {
    toolIds: [toolId],
    contentIds: [content.contentId],
    skillVersionIds: [skill.id],
    artifactIds: [artifact.id],
  };
  const profile = (await h.services.profiles.save(account.ownerId, {
    name: 'Safety Agent',
    ...grants,
  }))!;
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith(`/profiles/${profile.id}`)) writes++;
  });
  for (const path of ['tools', 'catalog', 'skills', 'artifacts', 'connections']) {
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    await page.route(`**/api/v1/${path}`, async (route) => {
      await held;
      await route.fulfill(failure(`${path} unavailable`));
    });
    await page.goto(h.baseURL + '/profiles');
    await openProfile('Safety Agent');
    await page.getByText('授权目录尚未完整加载', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '保存', exact: true }).count(), 0);
    release();
    const error = page
      .getByRole('dialog')
      .getByRole('alert')
      .filter({ hasText: `${path} unavailable` });
    await error.waitFor();
    assert.equal(writes, 0);
    await page.unroute(`**/api/v1/${path}`);
    await error.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByLabel('Agent 名称', { exact: true }).waitFor();
    for (const name of ['toolId', 'contentId', 'skillVersionId', 'artifactId']) {
      assert.equal(await page.locator(`input[name="${name}"]:checked`).count(), 1);
    }
  }
  await page.getByLabel('Agent 名称', { exact: true }).fill('Retained draft');
  await page.route('**/api/v1/skills', (route) => route.fulfill(failure('refresh failed')));
  await new Promise((done) => setTimeout(done, 5100));
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  const error = page.getByRole('dialog').getByRole('alert').filter({ hasText: 'refresh failed' });
  await error.waitFor();
  assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isEnabled(), false);
  assert.equal(await page.getByLabel('Agent 名称', { exact: true }).inputValue(), 'Retained draft');
  await page.unroute('**/api/v1/skills');
  await error.getByRole('button', { name: '重试', exact: true }).click();
  const response = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().endsWith(`/profiles/${profile.id}`),
  );
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal((await response).status(), 200);
  const saved = await (await account.request(`/profiles/${profile.id}`)).json();
  for (const [name, values] of Object.entries(grants)) assert.deepEqual(saved[name], values);
  assert.equal(saved.name, 'Retained draft');
  assert.equal(writes, 1);
}
async function tasks() {
  h.config.PI_ENABLED = 'true';
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  for (const path of ['me', 'tasks'])
    await page.route(`**/api/v1/${path}`, async (route) => {
      await held;
      await route.continue();
    });
  await page.goto(h.baseURL + '/tasks');
  await page.getByRole('heading', { name: '运行记录', exact: true }).waitFor();
  await page.locator('[aria-busy="true"]').first().waitFor();
  assert.equal(await page.getByText('内置 Agent 任务尚未启用', { exact: true }).count(), 0);
  assert.equal(await page.getByText('还没有任务记录。', { exact: true }).count(), 0);
  release();
  await page.getByRole('button', { name: '执行任务', exact: true }).waitFor();
  await page.getByText('还没有任务记录。', { exact: true }).waitFor();
  for (const path of ['me', 'tasks']) {
    await page.unroute(`**/api/v1/${path}`);
    await page.route(`**/api/v1/${path}`, (route) => route.fulfill(failure(`${path} unavailable`)));
  }
  await page.reload();
  await page.getByRole('alert').filter({ hasText: '任务配置加载失败' }).waitFor();
  await page.getByRole('alert').filter({ hasText: '任务记录加载失败' }).waitFor();
  assert.equal(await page.getByText('内置 Agent 任务尚未启用', { exact: true }).count(), 0);
  assert.equal(await page.getByText('还没有任务记录。', { exact: true }).count(), 0);
  for (const path of ['me', 'tasks']) await page.unroute(`**/api/v1/${path}`);
  await page
    .getByRole('alert')
    .filter({ hasText: '任务配置加载失败' })
    .getByRole('button', { name: '重试' })
    .click();
  await page
    .getByRole('alert')
    .filter({ hasText: '任务记录加载失败' })
    .getByRole('button', { name: '重试' })
    .click();
  await page.getByRole('button', { name: '执行任务', exact: true }).waitFor();
  await page.getByText('还没有任务记录。', { exact: true }).waitFor();
  h.config.PI_ENABLED = 'false';
  await page.reload();
  await page.getByText('内置 Agent 任务尚未启用', { exact: true }).waitFor();
}
async function drafts() {
  const connected = await connection();
  await page.goto(h.baseURL + '/network');
  await page.getByLabel('NO_PROXY', { exact: true }).fill('keep.example.test');
  await navigateConnections();
  await discard().getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(new URL(page.url()).pathname, '/network');
  assert.equal(
    await page.getByLabel('NO_PROXY', { exact: true }).inputValue(),
    'keep.example.test',
  );
  const beforeUnload = page.waitForEvent('dialog');
  const reload = page.reload().catch((error: Error) => {
    // A dismissed beforeunload may leave Chromium waiting for a load that never starts.
    assert.match(error.message, /ERR_ABORTED|Timeout .* exceeded/);
  });
  const prompt = await beforeUnload;
  assert.equal(prompt.type(), 'beforeunload');
  await prompt.dismiss();
  await reload;
  assert.equal(
    await page.getByLabel('NO_PROXY', { exact: true }).inputValue(),
    'keep.example.test',
  );
  await navigateConnections();
  await discard().getByRole('button', { name: '放弃修改并继续', exact: true }).click();
  await page.getByRole('heading', { name: '连接', exact: true }).waitFor();
  const open = async () => {
    await page.getByRole('button', { name: 'Safety connection 更多操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '编辑连接', exact: true }).click();
    await page.getByRole('button', { name: '高级设置', exact: true }).click();
  };
  await open();
  const editor = page.getByRole('dialog', { name: '编辑连接', exact: true });
  await page.getByLabel('连接名称', { exact: true }).fill('Unsaved connection');
  await editor.getByRole('button', { name: '关闭', exact: true }).click();
  await discard().getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(
    await page.getByLabel('连接名称', { exact: true }).inputValue(),
    'Unsaved connection',
  );
  await page.keyboard.press('Escape');
  await discard().getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('[data-slot=sheet-overlay]').click({ position: { x: 5, y: 200 } });
  await discard().getByRole('button', { name: '取消', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('Safety connection');
  await editor.getByRole('button', { name: '关闭', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.equal(await discard().count(), 0);
  await open();
  await page.getByLabel('启动方式', { exact: true }).click();
  await page.getByRole('option', { name: '按需唤醒', exact: true }).click();
  await editor.getByRole('button', { name: '关闭', exact: true }).click();
  await discard().getByRole('button', { name: '放弃修改并继续', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  await open();
  await page.getByLabel('启动方式', { exact: true }).click();
  await page.getByRole('option', { name: '按需唤醒', exact: true }).click();
  await page.getByLabel('启动方式', { exact: true }).click();
  await page.getByRole('option', { name: '保持现有连接行为', exact: true }).click();
  await editor.getByRole('button', { name: '关闭', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.equal(await discard().count(), 0);
  await open();
  const health = page.getByRole('checkbox', { name: '启用健康检查', exact: true });
  await health.setChecked(!(await health.isChecked()));
  await editor.getByRole('button', { name: '关闭', exact: true }).click();
  await discard().getByRole('button', { name: '放弃修改并继续', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  const saved = await h.services.connections.owned(account.ownerId, connected.id);
  assert.equal(saved.name, 'Safety connection');
  await page.goto(h.baseURL + '/network');
  await page.getByLabel('NO_PROXY', { exact: true }).fill('saved.example.test');
  await page.getByRole('button', { name: '保存网络设置', exact: true }).click();
  await page.getByText('网络设置与已保存版本一致', { exact: true }).waitFor();
  await navigateConnections();
  await page.getByRole('heading', { name: '连接', exact: true }).waitFor();
  assert.equal(await discard().count(), 0);
}
try {
  await { profiles, tasks, drafts }[group!]!();
  assert.equal(upstream.count(), 0, 'UI verification must not execute business tools');
  console.log(`PASS: editor safety ${group}`);
} finally {
  await context.close();
  await browser.close();
  if (group === 'drafts')
    await h.db.delete(networkConfiguration).where(eq(networkConfiguration.id, 'platform'));
  await h.close();
  await upstream.close();
}
