import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { harness } from '../tests/harness.js';
import { archive } from '../tests/fixtureBundle.js';
import { mountWeb } from '../apps/server/src/web.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const h = await harness();
await mountWeb(h.app, resolve('apps/web/dist'));
h.config.WEB_ORIGIN = h.baseURL;
// Platform-host MCPB/stdio is admin-only; a member context checks that the option is hidden.
const account = await h.signup({ role: 'admin' });
const member = await h.signup();
const profile = await h.services.profiles.save(account.ownerId, { name: 'Browser compression' });
const screenshots = resolve('.data/management-browser-acceptance');
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
context.setDefaultTimeout(10000);
await context.addCookies(
  account.cookie.split('; ').map((pair) => ({
    name: pair.slice(0, pair.indexOf('=')),
    value: pair.slice(pair.indexOf('=') + 1),
    url: h.baseURL,
  })),
);
const page = await context.newPage();
let connector: ReturnType<typeof spawn> | undefined;
const file = { name: 'fixture.mcpb', mimeType: 'application/zip', buffer: Buffer.from(archive()) };
try {
  await page.goto(h.baseURL + '/library');
  await page.getByLabel('名称', { exact: true }).fill('Browser prompt');
  await page.getByLabel('提示词模板', { exact: true }).fill('Hello {{topic}}');
  await page.getByRole('button', { name: '添加参数', exact: true }).click();
  await page.getByLabel('参数 1 名称', { exact: true }).fill('topic');
  await page.getByRole('checkbox', { name: '必填', exact: true }).check();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('Browser prompt', { exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('参数值（JSON）').fill('{"topic":"browser"}');
  await page.getByLabel('提示词模板', { exact: true }).fill('Draft hello {{topic}}');
  await page.getByRole('button', { name: '预览当前草稿', exact: true }).click();
  await page.getByText('Draft hello browser', { exact: false }).waitFor();
  await page.getByText('预览已更新', { exact: true }).waitFor();
  await page.getByLabel('参数值（JSON）').fill('{"topic":"changed"}');
  assert.equal(await page.getByText('预览已更新', { exact: true }).count(), 0);
  assert.equal(await page.locator('pre').filter({ hasText: 'Draft hello browser' }).count(), 0);
  await page.getByRole('button', { name: '预览当前草稿', exact: true }).click();
  await page.locator('pre').filter({ hasText: 'Draft hello changed' }).waitFor();
  await page.getByLabel('参数值（JSON）').fill('{');
  assert.equal(await page.locator('pre').count(), 0);
  await page.getByRole('button', { name: '预览当前草稿', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await page.getByLabel('参数值（JSON）').fill('{"topic":"changed"}');
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.getByLabel('参数值（JSON）').fill('{}');
  await page.getByRole('button', { name: '预览当前草稿', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '缺少必填参数：topic' }).waitFor();
  await page.getByRole('checkbox', { name: '必填', exact: true }).uncheck();
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.getByRole('checkbox', { name: '必填', exact: true }).check();
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.getByRole('checkbox', { name: '必填', exact: true }).uncheck();
  await page.getByRole('button', { name: '预览当前草稿', exact: true }).click();
  await page.getByText('预览已更新', { exact: true }).waitFor();
  await page.getByRole('checkbox', { name: '必填', exact: true }).check();
  assert.equal(await page.getByText('预览已更新', { exact: true }).count(), 0);
  let releaseFailure!: () => void;
  const pendingFailure = new Promise<void>((done) => {
    releaseFailure = done;
  });
  await page.route('**/api/v1/library/prompts/preview', async (route) => {
    await pendingFailure;
    await route.continue();
  });
  const failingRequest = page.waitForRequest((r) => r.url().endsWith('/library/prompts/preview'));
  const failingResponse = page.waitForResponse((r) => r.url().endsWith('/library/prompts/preview'));
  await page.getByRole('button', { name: '预览当前草稿', exact: true }).click();
  await failingRequest;
  await page.getByRole('checkbox', { name: '必填', exact: true }).uncheck();
  releaseFailure();
  assert.equal((await failingResponse).status(), 400);
  await page.getByRole('button', { name: '预览当前草稿', exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByText('预览已更新', { exact: true }).count(), 0);
  await page.unroute('**/api/v1/library/prompts/preview');
  await page.getByRole('button', { name: '预览当前草稿', exact: true }).click();
  await page.getByText('预览已更新', { exact: true }).waitFor();
  await page.getByLabel('参数值（JSON）').fill('{"topic":"changed"}');
  await page.getByRole('checkbox', { name: '必填', exact: true }).check();
  await page.getByRole('combobox', { name: '内容类型', exact: true }).click();
  await page.getByRole('option', { name: 'Resource 资源', exact: true }).click();
  await page.getByRole('dialog', { name: '放弃未保存的修改？' }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(
    await page.getByLabel('提示词模板', { exact: true }).inputValue(),
    'Draft hello {{topic}}',
  );
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '概览', exact: true })
    .click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.ok(page.url().endsWith('/library'));
  await page.getByRole('button', { name: '编辑 JSON', exact: true }).click();
  await page.getByLabel('参数声明（JSON）').fill('{');
  await page.getByRole('button', { name: '使用参数表单', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await page.getByLabel('参数声明（JSON）').fill('[{"name":"topic","required":true}]');
  await page.getByRole('button', { name: '使用参数表单', exact: true }).click();
  let releasePreview: () => void = () => {};
  const pendingPreview = new Promise<void>((done) => {
    releasePreview = done;
  });
  await page.route('**/api/v1/library/prompts/preview', async (route) => {
    await pendingPreview;
    await route.continue();
  });
  await page.getByRole('button', { name: '预览当前草稿', exact: true }).click();
  await page.getByLabel('提示词模板', { exact: true }).fill('Newer draft {{topic}}');
  releasePreview();
  await page.getByText('草稿已修改，请重新预览。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '预览当前草稿', exact: true }).waitFor();
  assert.equal(await page.getByText('预览已更新', { exact: true }).count(), 0);
  await page.unroute('**/api/v1/library/prompts/preview');
  await page.getByRole('button', { name: '预览当前草稿', exact: true }).click();
  await page.getByText('Newer draft changed', { exact: false }).waitFor();
  await page.screenshot({ path: join(screenshots, 'library-desktop.png'), fullPage: true });
  await page.getByRole('combobox', { name: '状态', exact: true }).click();
  await page.getByRole('option', { name: '停用', exact: true }).click();
  assert.equal(await page.getByText('预览已更新', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('已停用 · 修订 2').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(screenshots, 'library-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '账号菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  // Let the drawer finish its close transition before typing into the page behind it.
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByLabel('名称', { exact: true }).fill('unsaved');
  await page.getByRole('combobox', { name: '内容类型', exact: true }).click();
  await page.getByRole('option', { name: 'Resource 资源', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改并继续', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('Browser resource');
  await page.getByLabel('资源 URI').fill('resource://browser');
  await page.getByLabel('静态文本').fill('<script>window.untrusted = true</script>');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('Browser resource', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => (window as any).untrusted), undefined);
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('dialog', { name: '删除“Browser resource”？' }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByText('Browser resource', { exact: true }).waitFor();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.getByText('还没有内容', { exact: true }).waitFor();
  await page.goto(h.baseURL + '/profiles');
  await page.getByRole('button', { name: `${profile!.name} 更多操作` }).click();
  await page.getByRole('menuitem', { name: '智能发现', exact: true }).click();
  await page.getByRole('checkbox', { name: '启用明确节选并保存完整原文' }).check();
  await page.getByRole('combobox', { name: '节选策略', exact: true }).click();
  await page.getByRole('option', { name: 'JSON 样本', exact: true }).click();
  const savedDiscovery = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().endsWith(`/profiles/${profile!.id}`),
  );
  await page.getByRole('button', { name: '保存发现配置', exact: true }).click();
  assert.equal((await savedDiscovery).status(), 200);
  assert.equal(
    (await h.services.profiles.list(account.ownerId)).find((p) => p.id === profile!.id)
      ?.resultPresentation.strategy,
    'json',
  );
  const memberContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  memberContext.setDefaultTimeout(10000);
  await memberContext.addCookies(
    member.cookie.split('; ').map((pair) => ({
      name: pair.slice(0, pair.indexOf('=')),
      value: pair.slice(pair.indexOf('=') + 1),
      url: h.baseURL,
    })),
  );
  const memberPage = await memberContext.newPage();
  await memberPage.goto(h.baseURL + '/connections');
  await memberPage
    .getByRole('banner')
    .getByRole('button', { name: '添加连接', exact: true })
    .click();
  await memberPage.getByRole('tab', { name: '自定义', exact: true }).click();
  await memberPage.getByRole('combobox', { name: '传输协议', exact: true }).click();
  await memberPage.getByRole('option', { name: 'Streamable HTTP', exact: true }).waitFor();
  assert.equal(await memberPage.getByRole('option', { name: 'stdio（本地进程）' }).count(), 0);
  await memberPage.keyboard.press('Escape');
  await memberPage.getByRole('combobox', { name: '执行适配器', exact: true }).click();
  await memberPage.getByRole('option', { name: '设备连接器', exact: true }).click();
  await memberPage.getByRole('combobox', { name: '传输协议', exact: true }).click();
  await memberPage.getByRole('option', { name: 'stdio（本地进程）', exact: true }).waitFor();
  await memberPage.keyboard.press('Escape');
  await memberPage.screenshot({ path: join(screenshots, 'member-no-host-stdio.png') });
  await memberContext.close();
  await page.goto(h.baseURL + '/connections');
  await page.getByRole('banner').getByRole('button', { name: '添加连接', exact: true }).click();
  await page.getByRole('tab', { name: '导入', exact: true }).click();
  await page.getByLabel('MCPB 文件', { exact: true }).setInputFiles(file);
  await page.getByRole('button', { name: '上传并解析' }).click();
  await page.getByLabel('key', { exact: true }).fill('browser-bundle-secret');
  await page.getByRole('button', { name: '预览执行配置' }).click();
  await page.getByRole('button', { name: '安装并连接' }).waitFor();
  await page.getByRole('combobox', { name: '执行位置', exact: true }).click();
  await page.getByRole('option', { name: '平台 Pi 桥接', exact: true }).click();
  await page.getByRole('button', { name: '安装并连接' }).waitFor({ state: 'hidden' });
  await page.getByRole('combobox', { name: '执行位置', exact: true }).click();
  await page.getByRole('option', { name: '平台直连', exact: true }).click();
  await page.getByRole('button', { name: '预览执行配置' }).click();
  await page.getByRole('button', { name: '安装并连接' }).waitFor();
  assert.ok(
    !(await page.locator('pre').allTextContents()).join('').includes('browser-bundle-secret'),
  );
  assert.equal(
    (await h.services.connections.list(account.ownerId)).filter((c) => c.name === 'bundle-fixture')
      .length,
    0,
  );
  await page.getByRole('button', { name: '安装并连接' }).click();
  await page.getByText('"succeeded"', { exact: false }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(screenshots, 'bundle-mobile.png'), fullPage: true });
  await page.reload();
  await page.getByRole('banner').getByRole('button', { name: '添加连接', exact: true }).click();
  await page.getByRole('tab', { name: '导入', exact: true }).click();
  const history = page.getByRole('region', { name: 'MCPB 安装历史' });
  await history.getByText('成功', { exact: true }).waitFor();
  await history.getByRole('button', { name: '卸载此连接及授权' }).click();
  await page.getByRole('button', { name: '确认卸载', exact: true }).click();
  await history.getByText('已卸载', { exact: false }).first().waitFor();
  await history.getByRole('button', { name: '清理未使用包文件' }).click();
  await page.getByRole('button', { name: '确认清理', exact: true }).click();
  await history.getByText('平台包文件已清理', { exact: true }).waitFor();
  assert.equal(
    (await h.services.connections.list(account.ownerId)).filter((c) => c.name === 'bundle-fixture')
      .length,
    0,
  );
  connector = spawn(
    resolve('connector/bin/connector'),
    ['manage', '--data-dir', join(h.directory, 'local-bundles')],
    { env: { ...process.env, HOME: h.directory }, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const localUrl = await new Promise<string>((done, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Local management URL not ready')), 10000);
    connector!.stderr!.on('data', (chunk) => {
      output += String(chunk);
      const match = /http:\/\/127\.0\.0\.1:\d+\/#open=[a-f0-9]+/.exec(output);
      if (match) {
        clearTimeout(timer);
        done(match[0]);
      }
    });
  });
  const local = await context.newPage();
  await local.setViewportSize({ width: 375, height: 844 });
  await local.goto(localUrl);
  await local.getByRole('tab', { name: 'MCPB 扩展包' }).click();
  await local.getByLabel('MCPB 文件', { exact: true }).setInputFiles(file);
  await local.getByRole('button', { name: '解析本机 MCPB' }).click();
  await local.getByLabel('key', { exact: true }).fill('local-only-secret');
  await local.getByRole('button', { name: '预览本机配置' }).click();
  await local.getByRole('button', { name: '保存到本机' }).click();
  await local.getByRole('button', { name: '连接验证', exact: true }).click();
  await local.getByText('"echo"', { exact: false }).waitFor();
  assert.ok(!(await local.locator('pre').allTextContents()).join('').includes('local-only-secret'));
  assert.ok(await local.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await local.screenshot({ path: join(screenshots, 'local-bundle-mobile.png'), fullPage: true });
  await local.getByRole('button', { name: '停止', exact: true }).click();
  await local.getByText('"stopped": true', { exact: false }).waitFor();
  await local.getByRole('button', { name: '查看客户端配置', exact: true }).click();
  await local.getByText('bundle-stdio', { exact: false }).waitFor();
  assert.ok(!(await local.locator('pre').allTextContents()).join('').includes('local-only-secret'));
  await local.reload();
  await local.getByRole('tab', { name: 'MCPB 扩展包' }).click();
  await local.getByRole('button', { name: '移除本机配置', exact: true }).click();
  await local.getByRole('button', { name: '连接验证', exact: true }).waitFor({ state: 'detached' });
  assert.ok(await local.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log(
    'PASS: member sees no platform-host stdio option, library draft preview/race/discard/arguments/confirmation/loading state, CRUD/disable, HTML literal content, compression persistence, MCPB preview/install/discovery, history reload/uninstall/cleanup, local encrypted setup/start/stop/client config/removal, narrow layouts',
  );
} catch (error) {
  console.error(error);
  for (const [index, opened] of context.pages().entries())
    await opened.screenshot({ path: join(screenshots, `failure-${index}.png`), fullPage: true });
  throw error;
} finally {
  await context.close();
  await browser.close();
  if (connector && connector.exitCode === null) {
    const stopped = new Promise<void>((done) => connector!.once('exit', () => done()));
    connector.kill('SIGINT');
    await stopped;
  }
  await h.close();
}
