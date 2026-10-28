import { Hono } from 'hono';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { sandboxApp } from '../apps/server/src/modules/apps/sandbox.js';
import { mountWeb } from '../apps/server/src/web.js';
import type { ApiEnv } from '../apps/server/src/shared/http.js';

const html = '<!doctype html><div id="app"></div>';
let directory: string;
let app: Hono<ApiEnv>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'platform-web-'));
  const web = join(directory, 'public');
  await mkdir(join(web, 'assets'), { recursive: true });
  await writeFile(join(web, 'index.html'), html);
  await writeFile(join(web, 'assets/app.js'), 'console.log("web");');
  await writeFile(join(directory, 'private.txt'), 'outside web root');
  app = new Hono<ApiEnv>();
  app.get('/api/version', (c) => c.json({ version: 'test' }));
  await mountWeb(app, web);
});
afterAll(async () => {
  await rm(directory, { recursive: true });
});

test('one application serves the web shell, direct navigation, assets and API', async () => {
  for (const path of ['/', '/connections', '/authorize?client_id=client']) {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toBe(html);
  }
  const asset = await app.request('/assets/app.js');
  expect(asset.status).toBe(200);
  expect(asset.headers.get('content-type')).toContain('javascript');
  expect(await asset.text()).toBe('console.log("web");');
  expect(await (await app.request('/api/version')).json()).toEqual({ version: 'test' });
  const head = await app.request('/', { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
});

test('missing assets and endpoints and traversal return 404 instead of the web shell', async () => {
  for (const path of [
    '/assets/missing.js',
    '/assets/missing',
    '/missing.svg',
    '/api/missing',
    '/mcp/missing',
    '/.well-known/missing',
    '/health/missing',
    '/_apps/missing',
    '/%2e%2e%2fprivate.txt',
  ]) {
    const response = await app.request(path);
    expect(response.status, path).toBe(404);
    expect(await response.text()).not.toBe(html);
  }
  expect((await app.request('/connections', { method: 'POST' })).status).toBe(404);
});

test('missing production web build fails explicitly', async () => {
  await expect(mountWeb(new Hono<ApiEnv>(), join(directory, 'missing'))).rejects.toThrow('ENOENT');
});

test('same-endpoint sandbox supports opaque requests without allowing credentialed CORS', async () => {
  const origin = 'https://platform.example';
  const routes = new Hono().route('/_apps', sandboxApp([origin], origin, '/_apps'));
  const proxy = await routes.request(`/_apps/sandbox?parent=${encodeURIComponent(origin)}`);
  expect(proxy.status).toBe(200);
  expect(await proxy.text()).toContain('http-equiv="Content-Security-Policy"');
  const preflight = await routes.request('/_apps/frames', {
    method: 'OPTIONS',
    headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe('null');
  expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
  for (const requester of [origin, 'https://evil.example']) {
    const response = await routes.request('/_apps/frames', {
      method: 'POST',
      headers: { Origin: requester, 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: 'denied' }),
    });
    expect(response.status).toBe(403);
  }
  const created = await routes.request('/_apps/frames', {
    method: 'POST',
    headers: { Origin: 'null', 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<h1>isolated</h1>' }),
  });
  expect(created.status).toBe(200);
  expect(created.headers.get('access-control-allow-origin')).toBe('null');
  expect(created.headers.get('access-control-allow-credentials')).toBeNull();
  const { path } = (await created.json()) as { path: string };
  expect(path).toMatch(/^\/_apps\/frames\//);
  const frame = await routes.request(path);
  expect(frame.headers.get('content-security-policy')).toContain(
    'sandbox allow-scripts allow-forms',
  );
  expect(await frame.text()).toBe('<h1>isolated</h1>');
  expect((await routes.request(path)).status).toBe(410);
});
