import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connectorPresets } from '../packages/contracts/src/index.js';
import { harness } from '../tests/harness.js';
import { mountWeb } from '../apps/server/src/web.js';

// Saved vendor configurations only: opening management must not contact the vendor.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const h = await harness();
await mountWeb(h.app, resolve('apps/web/dist'));
h.config.WEB_ORIGIN = h.baseURL;
const account = await h.signup();
const preset = connectorPresets.find((item) => item.id === 'cloudflare')!;
for (const name of ['Cloudflare', 'Cloudflare 工作账号']) {
  await h.services.connections.create(account.ownerId, {
    name,
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: preset.url,
  });
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const screenshots = resolve('.data/connector-management-browser');
await mkdir(screenshots, { recursive: true });
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
    let writes = 0;
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('request', (request) => {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes++;
    });
    const add = () => page.getByRole('dialog', { name: '添加连接', exact: true });
    const editor = () => page.getByRole('dialog', { name: '编辑连接', exact: true });
    const openCatalog = async () => {
      await page.getByRole('button', { name: '添加连接', exact: true }).click();
      await add().getByRole('button', { name: '管理 Cloudflare', exact: true }).click();
    };
    await page.goto(h.baseURL + '/connections');
    await page.getByRole('searchbox', { name: '搜索连接' }).fill('no matching connection');
    await page.getByText('没有符合筛选条件的连接。', { exact: true }).waitFor();
    await openCatalog();
    const manage = page.getByRole('menuitem', { name: '管理 Cloudflare', exact: true });
    if (viewport.width === 1280) {
      await manage.focus();
      await manage.press('Enter');
    } else {
      await manage.click();
    }
    await editor().waitFor();
    await add().waitFor({ state: 'detached' });
    assert.equal(await editor().getByLabel('连接名称', { exact: true }).inputValue(), 'Cloudflare');
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return dialog?.contains(document.activeElement);
    });
    assert.equal(new URL(page.url()).hash, '');
    await page.screenshot({
      path: resolve(screenshots, `management-${viewport.width}.png`),
      fullPage: true,
    });
    await editor().getByRole('button', { name: '关闭', exact: true }).click();
    await editor().waitFor({ state: 'detached' });
    await openCatalog();
    await page.getByRole('menuitem', { name: '管理 Cloudflare 工作账号', exact: true }).click();
    await editor().waitFor();
    await add().waitFor({ state: 'detached' });
    const name = editor().getByLabel('连接名称', { exact: true });
    assert.equal(await name.inputValue(), 'Cloudflare 工作账号');
    await name.fill('未保存的账号名称');
    await editor().getByRole('button', { name: '关闭', exact: true }).click();
    const discard = page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true });
    await discard.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await name.inputValue(), '未保存的账号名称');
    await editor().getByRole('button', { name: '关闭', exact: true }).click();
    await discard.getByRole('button', { name: '放弃修改并继续', exact: true }).click();
    await editor().waitFor({ state: 'detached' });
    await openCatalog();
    await page.getByRole('menuitem', { name: '添加另一个 Cloudflare', exact: true }).click();
    const create = page.getByRole('dialog', { name: '添加 Cloudflare', exact: true });
    await create.waitFor();
    assert.equal(await create.getByLabel('连接名称', { exact: true }).inputValue(), 'Cloudflare');
    await create.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(writes, 0, 'Management navigation must not save, authorize or execute a tool');
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    'PASS: connector management opens the selected settings despite filters, supports repeated/keyboard/mobile use, protects drafts and preserves add-another without business calls',
  );
} finally {
  await Promise.all(browser.contexts().map((context) => context.close()));
  await browser.close();
  await h.close();
}
