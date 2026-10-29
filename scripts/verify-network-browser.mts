import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { user, networkConfiguration, updateChecks } from '../packages/db/src/index.js';
import { harness } from '../tests/harness.js';
import { mountWeb } from '../apps/server/src/web.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const h = await harness();
await mountWeb(h.app, resolve('apps/web/dist'));
const admin = await h.signup();
const member = await h.signup();
await h.db.update(user).set({ role: 'admin' }).where(eq(user.id, admin.ownerId));
h.config.WEB_ORIGIN = h.baseURL;
const screenshots = resolve('.data/network-browser-acceptance');
await mkdir(screenshots, { recursive: true });
const fixture = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url?.includes('/releases'))
    res.end(
      JSON.stringify([
        {
          tag_name: 'v99.0.0',
          draft: false,
          prerelease: false,
          published_at: '2026-10-29T00:00:00Z',
          body: '# Fixture release\n<img src=x onerror=alert(1)>',
          html_url: 'https://github.com/yibaiba/mcp-platform/releases/tag/v99.0.0',
        },
      ]),
    );
  else res.end(JSON.stringify({ versions: { '1.0.0': {}, '1.1.0': {}, '2.0.0-rc.1': {} } }));
});
await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done));
const source = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
await h.services.connections.create(admin.ownerId, {
  name: 'Browser package fixture',
  adapter: 'direct',
  transport: 'stdio',
  mode: 'managed',
  command: 'npx',
  args: ['--registry', source, 'fixture-package@1.0.0'],
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let connector: ReturnType<typeof spawn> | undefined;
async function context(cookie: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies(
    cookie.split('; ').map((pair) => ({
      name: pair.slice(0, pair.indexOf('=')),
      value: pair.slice(pair.indexOf('=') + 1),
      url: h.baseURL,
    })),
  );
  return ctx;
}
try {
  const ctx = await context(admin.cookie);
  ctx.setDefaultTimeout(8000);
  const page = await ctx.newPage();
  await page.goto(h.baseURL + '/network');
  await page.getByLabel('GitHub API 基地址', { exact: true }).fill(source);
  await page.getByLabel('npm 公共镜像', { exact: true }).fill(source);
  await page.getByLabel('GitHub 下载模板', { exact: true }).fill(source + '/download/{encodedUrl}');
  await page
    .getByLabel('GitHub Git 克隆模板', { exact: true })
    .fill(source + '/git/{owner}/{repo}.git');
  await page.getByLabel('GitHub API 独立令牌操作', { exact: true }).selectOption('replace');
  await page.getByLabel('GitHub API 独立令牌', { exact: true }).fill('browser-fixture-secret');
  await page.getByRole('button', { name: '保存网络设置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  await page.reload();
  await page.getByText('已保存，无法回读；可保留、更换或清除。').waitFor();
  assert.equal(await page.locator('input[type=password]').count(), 0);
  assert.ok(!(await page.content()).includes('browser-fixture-secret'));
  await page.screenshot({ path: join(screenshots, 'network-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(screenshots, 'network-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '检查已保存设置的连通性' }).click();
  await page.getByText('api：成功', { exact: false }).waitFor();
  await page.getByText('git：失败', { exact: false }).waitFor();
  await page.goto(h.baseURL + '/about');
  await page.getByRole('button', { name: '检查平台更新', exact: true }).click();
  await page.getByText('开发构建，不与发行版本判断先后', { exact: false }).waitFor();
  assert.equal(await page.locator('article img').count(), 0);
  await page.screenshot({ path: join(screenshots, 'about-mobile.png'), fullPage: true });
  await page.goto(h.baseURL + '/connections');
  await page.getByRole('button', { name: 'Browser package fixture 更多操作' }).click();
  await page.getByRole('menuitem', { name: '编辑连接', exact: true }).click();
  await page.getByRole('button', { name: '手动检查更新', exact: true }).click();
  await page.getByText('1.1.0 · 有更新可用').waitFor();
  await page.screenshot({ path: join(screenshots, 'package-mobile.png'), fullPage: true });
  const restricted = await context(member.cookie);
  const other = await restricted.newPage();
  await other.goto(h.baseURL + '/about');
  await other.getByText('管理员可以发起检查或开启定时检查。').waitFor();
  assert.equal(await other.getByRole('button', { name: '检查平台更新' }).count(), 0);
  await other.goto(h.baseURL + '/network');
  await other.getByRole('alert').filter({ hasText: '管理员' }).waitFor();
  connector = spawn(
    resolve('connector/bin/connector'),
    ['manage', '--data-dir', join(h.directory, 'local-network')],
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
  const local = await ctx.newPage();
  await local.setViewportSize({ width: 375, height: 844 });
  await local.goto(localUrl);
  await local.getByRole('tab', { name: '网络与安装源' }).click();
  await local.getByLabel('npm 公共镜像', { exact: true }).fill(source);
  await local.getByRole('button', { name: '保存网络设置', exact: true }).click();
  await local.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.ok(await local.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await local.screenshot({ path: join(screenshots, 'local-network-mobile.png'), fullPage: true });
  console.log(
    'PASS: admin/member UI, encrypted credential echo, independent connectivity results, package checks, release HTML isolation, platform/device settings and 375/390px layouts',
  );
} finally {
  if (connector && connector.exitCode === null) {
    const stopped = new Promise<void>((done) => connector!.once('exit', () => done()));
    connector.kill('SIGINT');
    await stopped;
  }
  await browser.close();
  await h.db.delete(networkConfiguration);
  await h.db.delete(updateChecks).where(eq(updateChecks.id, 'platform'));
  await h.close();
  await new Promise<void>((done) => fixture.close(() => done()));
}
