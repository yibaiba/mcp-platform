import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer } from 'node:http';
import { eq } from 'drizzle-orm';
import { networkConfiguration, updateChecks, user } from '../packages/db/src/index.js';
import { harness } from './harness.js';
import {
  PlatformUpdateService,
  releaseState,
} from '../apps/server/src/modules/updates/platformService.js';
import { startUpdateChecks } from '../apps/server/src/modules/updates/scheduler.js';
import { UPDATE_INTERVAL_MS } from '../apps/server/src/modules/updates/packageService.js';
let h: Awaited<ReturnType<typeof harness>>;
let admin: Awaited<ReturnType<typeof h.signup>>;
let member: Awaited<ReturnType<typeof h.signup>>;
const build = {
  version: 'v1.0.0',
  commit: 'a'.repeat(40),
  builtAt: '2026-10-29T00:00:00Z',
  release: true,
};
const stable = {
  tag_name: 'v1.2.0',
  draft: false,
  prerelease: false,
  published_at: '2026-10-28T00:00:00Z',
  body: '<img src=x onerror=alert(1)>\n# Release notes',
  html_url: 'https://github.com/yibaiba/mcp-platform/releases/tag/v1.2.0',
};
let mode = 'release';
let conditional = false;
const fixture = createServer((req, res) => {
  if (mode === 'pages') {
    const page = new URL(req.url!, 'http://fixture');
    if (!page.searchParams.has('page')) {
      res.setHeader('Link', `<http://${req.headers.host}${page.pathname}?page=2>; rel="next"`);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ ...stable, tag_name: 'v2.0.0-rc.1', prerelease: true }]));
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([stable]));
    }
    return;
  }
  if (mode === 'limited') {
    res.writeHead(403, { 'x-ratelimit-remaining': '0' });
    res.end();
    return;
  }
  if (mode === 'failure') {
    res.writeHead(500);
    res.end();
    return;
  }
  if (mode === 'cached' && req.headers['if-none-match'] === '"release"') {
    conditional = true;
    res.writeHead(304);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"release"' });
  res.end(
    JSON.stringify(
      mode === 'empty' ? [] : [{ ...stable, tag_name: 'v2.0.0-rc.1', prerelease: true }, stable],
    ),
  );
});
beforeAll(async () => {
  h = await harness();
  admin = await h.signup();
  member = await h.signup();
  await h.db.update(user).set({ role: 'admin' }).where(eq(user.id, admin.ownerId));
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  await h.services.network.save(admin.ownerId, {
    revision: 0,
    settings: { githubApi: `http://127.0.0.1:${(fixture.address() as { port: number }).port}` },
  });
});
afterAll(async () => {
  await h.db.delete(updateChecks).where(eq(updateChecks.id, 'platform'));
  await h.db.delete(networkConfiguration);
  await h.close();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
});
const service = () =>
  new PlatformUpdateService({
    db: h.db,
    network: h.services.network,
    build,
    now: () => new Date(),
  });
test('release builds compare stable versions; development builds never imply they are outdated', () => {
  expect(releaseState(build, stable)).toBe('available');
  expect(releaseState({ ...build, version: 'v1.2.0' }, stable)).toBe('up_to_date');
  expect(releaseState({ ...build, version: 'dev', release: false }, stable)).toBe('development');
  expect(releaseState(build, null)).toBe('no_release');
});
test('authenticated members can view but only administrators check or schedule updates', async () => {
  expect((await h.app.request('/api/v1/version')).status).toBe(401);
  const current = await member.request('/version');
  expect(current.status).toBe(200);
  expect(await current.json()).toMatchObject({ result: null, scheduled: false });
  expect((await member.request('/admin/platform-update', { method: 'POST' })).status).toBe(403);
  expect(
    (
      await member.request('/admin/platform-update', {
        method: 'PATCH',
        body: JSON.stringify({ scheduled: true }),
      })
    ).status,
  ).toBe(403);
});
test('real release fixture filters prereleases, preserves untrusted notes as data and reuses conditional cache', async () => {
  const updates = service();
  expect(await updates.check(admin.ownerId)).toMatchObject({
    result: { state: 'available', release: stable },
    scheduled: false,
  });
  const dev = new PlatformUpdateService({
    db: h.db,
    network: h.services.network,
    build: { ...build, version: 'dev', release: false },
    now: () => new Date(),
  });
  expect(await dev.status()).toMatchObject({ result: { state: 'development' } });
  mode = 'cached';
  expect(await updates.check(admin.ownerId)).toMatchObject({
    result: { state: 'available', release: stable },
  });
  expect(conditional).toBe(true);
  const publicData = await updates.status();
  expect(publicData.result).not.toHaveProperty('cache');
});
test('rate limits, request failures and no releases are distinct, failed checks never say latest', async () => {
  const updates = service();
  mode = 'limited';
  expect(await updates.check(admin.ownerId)).toMatchObject({
    result: { state: 'rate_limited', previousStale: true },
  });
  mode = 'failure';
  expect(await updates.check(admin.ownerId)).toMatchObject({ result: { state: 'failed' } });
  mode = 'empty';
  expect(await updates.check(admin.ownerId)).toMatchObject({
    result: { state: 'no_release', release: null },
  });
  mode = 'release';
});
test('injected 24h scheduler does not catch up after restart or replay missed intervals', async () => {
  let now = new Date('2026-10-29T00:00:00Z');
  let tick: () => void | Promise<void> = () => {};
  let calls = 0;
  let stopped = false;
  await service().schedule(admin.ownerId, { scheduled: true });
  const stop = await startUpdateChecks({
    db: h.db,
    clock: {
      now: () => now,
      every: (fn) => {
        tick = fn;
        return () => {
          stopped = true;
        };
      },
    },
    packageCheck: async () => {
      throw new Error('unexpected package task');
    },
    platformCheck: async () => {
      calls++;
    },
    failed: () => {
      throw new Error('unexpected scheduler failure');
    },
  });
  await tick();
  expect(calls).toBe(0);
  now = new Date(now.getTime() + UPDATE_INTERVAL_MS * 3);
  await tick();
  await expect.poll(() => calls).toBe(1);
  await tick();
  expect(calls).toBe(1);
  await stop();
  expect(stopped).toBe(true);
});

test('custom API pagination remains on the configured endpoint and finds stable releases beyond the first page', async () => {
  mode = 'pages';
  try {
    expect(await service().check(admin.ownerId)).toMatchObject({
      result: { state: 'available', release: stable },
    });
  } finally {
    mode = 'release';
  }
});
