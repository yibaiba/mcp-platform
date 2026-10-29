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
const account = await h.signup();
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
  await page.getByLabel('参数声明（JSON）').fill('[{"name":"topic","required":true}]');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('Browser prompt', { exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('参数值（JSON）').fill('{"topic":"browser"}');
  await page.getByRole('button', { name: '预览已保存的模板' }).click();
  await page.getByText('Hello browser', { exact: false }).waitFor();
  await page.screenshot({ path: join(screenshots, 'library-desktop.png'), fullPage: true });
  await page.getByLabel('状态', { exact: true }).selectOption('false');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('已停用 · 修订 2').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(screenshots, 'library-mobile.png'), fullPage: true });
  await page.getByLabel('内容类型').selectOption('resource');
  await page.getByLabel('名称', { exact: true }).fill('Browser resource');
  await page.getByLabel('资源 URI').fill('resource://browser');
  await page.getByLabel('静态文本').fill('<script>window.untrusted = true</script>');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('Browser resource', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => (window as any).untrusted), undefined);
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByText('还没有内容。').waitFor();
  await page.goto(h.baseURL + '/profiles');
  await page.getByRole('button', { name: '智能发现', exact: true }).click();
  await page.getByRole('checkbox', { name: '启用明确节选并保存完整原文' }).check();
  await page.getByLabel('节选策略', { exact: true }).selectOption('json');
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
  await page.goto(h.baseURL + '/connections');
  await page.getByText('导入 MCPB 扩展包', { exact: true }).click();
  await page.getByLabel('MCPB 文件', { exact: true }).setInputFiles(file);
  await page.getByRole('button', { name: '上传并解析' }).click();
  await page.getByLabel('key', { exact: true }).fill('browser-bundle-secret');
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
  await page.getByText('导入 MCPB 扩展包', { exact: true }).click();
  const history = page.getByRole('region', { name: 'MCPB 安装历史' });
  await history.getByText('成功', { exact: true }).waitFor();
  await history.getByRole('button', { name: '卸载此连接及授权' }).click();
  await history.getByText('已卸载', { exact: false }).first().waitFor();
  await history.getByRole('button', { name: '清理未使用包文件' }).click();
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
    'PASS: library CRUD/preview/disable, HTML literal content, compression persistence, MCPB preview/install/discovery, history reload/uninstall/cleanup, local encrypted setup/start/stop/client config/removal, narrow layouts',
  );
} catch (error) {
  console.error(error);
  for (const [index, opened] of context.pages().entries())
    await opened.screenshot({ path: join(screenshots, `failure-${index}.png`), fullPage: true });
  throw error;
} finally {
  if (connector && connector.exitCode === null) {
    const stopped = new Promise<void>((done) => connector!.once('exit', () => done()));
    connector.kill('SIGINT');
    await stopped;
  }
  await browser.close();
  await h.close();
}
