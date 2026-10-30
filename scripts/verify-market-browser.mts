import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { registryServer } from '../packages/contracts/src/index.js';
import { harness } from '../tests/harness.js';
import { mountWeb } from '../apps/server/src/web.js';

// UI-only Registry fixtures; no installation or external business calls are performed.
const servers = Array.from({ length: 30 }, (_, index) =>
  registryServer.parse({
    name: `io.example/service-${index}`,
    title: `Catalog service ${index}`,
    version: '2.0.0',
    description: 'Search and read service information. 查询并读取服务信息。',
    remotes: [{ type: 'streamable-http', url: 'https://example.test/mcp' }],
  }),
);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const h = await harness();
await mountWeb(h.app, resolve('apps/web/dist'));
h.config.WEB_ORIGIN = h.baseURL;
const account = await h.signup();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('.data/market-browser-acceptance', { recursive: true });
try {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    const context = await browser.newContext({
      viewport,
      reducedMotion: viewport.width === 390 ? 'reduce' : 'no-preference',
    });
    await context.addInitScript(
      (theme) => localStorage.setItem('mcp-theme', theme),
      viewport.width === 390 ? 'dark' : 'light',
    );
    context.setDefaultTimeout(5000);
    await context.addCookies(
      account.cookie.split('; ').map((pair) => ({
        name: pair.slice(0, pair.indexOf('=')),
        value: pair.slice(pair.indexOf('=') + 1),
        url: h.baseURL,
      })),
    );
    const page = await context.newPage();
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    let pending = true;
    let failed = false;
    let writes = 0;
    await page.route('**/api/v1/market/**', async (route) => {
      const request = route.request();
      if (request.method() !== 'GET') writes++;
      const url = new URL(request.url());
      if (url.pathname.endsWith('/server')) {
        if (pending) await held;
        if (failed) {
          await route.fulfill({
            status: 503,
            json: { error: { message: 'Registry unavailable' } },
          });
          return;
        }
        const server = servers.find((item) => item.name === url.searchParams.get('name'))!;
        await route.fulfill({
          json: {
            server: {
              ...server,
              version: url.searchParams.get('version') === '1.0.0' ? '1.0.0' : server.version,
            },
            choices: [
              {
                distribution: 'remote',
                index: 0,
                label: 'streamable-http · https://example.test/mcp',
                fields: [],
              },
            ],
          },
        });
        return;
      }
      const items = url.pathname.endsWith('/versions')
        ? [{ ...servers[27]!, version: '1.0.0' }]
        : servers;
      await route.fulfill({ json: { servers: items.map((server) => ({ server })), metadata: {} } });
    });
    await page.goto(h.baseURL + '/market');
    const trigger = page
      .locator('.connection-row')
      .filter({ has: page.getByRole('heading', { name: 'Catalog service 27', exact: true }) })
      .getByRole('button', { name: '详情与安装', exact: true });
    await trigger.scrollIntoViewIfNeeded();
    const before = await trigger.boundingBox();
    assert.ok(before);
    const scroll = await page.evaluate(() => window.scrollY);
    assert.ok(scroll > viewport.height, 'Open details from deep in the result list');
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('status').filter({ hasText: '正在加载服务详情' }).waitFor();
    await page.waitForFunction(() => {
      const bounds = document.querySelector('[data-slot="sheet-title"]')?.getBoundingClientRect();
      return (
        bounds &&
        bounds.top >= 0 &&
        bounds.bottom <= innerHeight &&
        bounds.left >= 0 &&
        bounds.right <= innerWidth
      );
    });
    pending = false;
    release();
    await dialog.getByRole('heading', { name: 'Catalog service 27', exact: true }).waitFor();
    await dialog.getByRole('button', { name: '预览安装配置', exact: true }).waitFor();
    await dialog.getByRole('combobox', { name: '服务版本', exact: true }).click();
    await page.getByRole('option', { name: '1.0.0', exact: true }).click();
    await dialog.getByRole('combobox', { name: '服务版本', exact: true }).click();
    await page.getByRole('option', { name: '最新版本（1.0.0）', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await dialog.getByLabel('连接名称', { exact: true }).fill('Draft installation');
    assert.ok(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth));
    await page.screenshot({ path: `.data/market-browser-acceptance/detail-${viewport.width}.png` });
    // Escape returns both scroll position and keyboard focus to the original result.
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.textContent === '详情与安装');
    assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
    await page.waitForFunction((expected) => Math.abs(window.scrollY - expected) <= 1, scroll);
    const after = await trigger.boundingBox();
    assert.ok(after && Math.abs(after.y - before.y) <= 1);
    await trigger.click();
    await dialog.getByLabel('连接名称', { exact: true }).waitFor();
    assert.equal(
      await dialog.getByLabel('连接名称', { exact: true }).inputValue(),
      'Catalog service 27',
    );
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    // Request failures must also appear immediately in the visible detail drawer.
    failed = true;
    const other = page
      .locator('.connection-row')
      .filter({ has: page.getByRole('heading', { name: 'Catalog service 28', exact: true }) })
      .getByRole('button', { name: '详情与安装', exact: true });
    await other.click();
    await dialog.getByRole('alert').filter({ hasText: 'Registry unavailable' }).waitFor();
    assert.equal(
      await dialog.getByRole('button', { name: '预览安装配置', exact: true }).count(),
      0,
    );
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(writes, 0, 'Viewing details must not install or call a tool');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await context.close();
  }
  console.log(
    'PASS: market details visible during loading/success/failure, version selection, close/Escape, focus/scroll restoration, desktop/mobile/landscape and reduced motion',
  );
} finally {
  await browser.close();
  await h.close();
}
