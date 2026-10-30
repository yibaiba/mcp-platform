import assert from 'node:assert/strict';
import { harness } from '../tests/harness.js';
import { mountWeb } from '../apps/server/src/web.js';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const h = await harness();
await mountWeb(h.app, resolve('apps/web/dist'));
h.config.WEB_ORIGIN = h.baseURL;
const account = await h.signup();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
context.setDefaultTimeout(8000);
await context.addCookies(
  account.cookie.split('; ').map((pair) => ({
    name: pair.slice(0, pair.indexOf('=')),
    value: pair.slice(pair.indexOf('=') + 1),
    url: h.baseURL,
  })),
);
try {
  const page = await context.newPage();
  let release: () => void = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route('**/api/v1/library/prompts', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(h.baseURL + '/library');
  await page.locator('[aria-busy="true"]').first().waitFor();
  assert.equal(await page.getByText('还没有内容', { exact: true }).count(), 0);
  release();
  await page.getByText('还没有内容', { exact: true }).waitFor();
  await page.unroute('**/api/v1/library/prompts');
  await page.route('**/api/v1/library/prompts', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'TEST_UNAVAILABLE', message: '内容服务暂不可用' } }),
    }),
  );
  await page.reload();
  await page.getByRole('alert').filter({ hasText: '内容服务暂不可用' }).waitFor();
  assert.equal(await page.getByText('还没有内容', { exact: true }).count(), 0);
  await page.unroute('**/api/v1/library/prompts');
  await page.getByRole('alert').getByRole('button', { name: '重试', exact: true }).click();
  await page.getByText('还没有内容', { exact: true }).waitFor();
  await page.getByLabel('名称', { exact: true }).fill('keep me');
  await page.getByRole('link', { name: 'MCP 连接', exact: true }).click();
  await page.getByRole('button', { name: '放弃修改并继续', exact: true }).click();
  await page.getByRole('heading', { name: '连接', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 600 });
  await page.getByRole('button', { name: '打开导航菜单', exact: true }).click();
  await mkdir('.data/ui-browser-acceptance', { recursive: true });
  await page.screenshot({ path: '.data/ui-browser-acceptance/mobile-navigation.png' });
  await page.getByRole('dialog').getByRole('link', { name: '内容库', exact: true }).click();
  await page.getByRole('heading', { name: '内容库', exact: true }).waitFor();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  console.log('PASS: library loading/empty/error/retry, route discard, mobile drawer navigation');
} finally {
  await browser.close();
  await h.close();
}
