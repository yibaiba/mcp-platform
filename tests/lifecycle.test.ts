import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLifecycle } from '../apps/server/src/modules/mcp/lifecycle/sessionLifecycle.js';
import { connectionInput } from '../packages/contracts/src/index.js';
import { ManagedStdioTransport } from '../packages/mcp/src/index.js';
import type {
  ConnectionAdapter,
  ConnectionContext,
} from '../apps/server/src/modules/mcp/adapter.js';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup() {
  const context: ConnectionContext = {
    id: 'unit-session',
    ownerId: 'unit-owner',
    runtimeKey: 'unit-session',
    config: connectionInput.parse({
      name: 'Unit',
      adapter: 'direct',
      transport: 'http',
      mode: 'existing',
      url: 'https://example.com',
      lifecycle: { idleTimeoutMs: 10 },
      health: {
        enabled: true,
        intervalMs: 60,
        timeoutMs: 5,
        recover: true,
        initialIntervalMs: 5,
        maxIntervalMs: 20,
      },
    }),
  };
  const catalog = { tools: [], prompts: [], resources: [], templates: [], capabilities: {} };
  const adapter: ConnectionAdapter = {
    status: () => 'connected',
    watch: () => () => {},
    catalog: async () => catalog,
    discover: async () => [],
    request: vi.fn(async () => ({})),
    call: vi.fn(async () => {
      throw new Error('execution failed');
    }),
    close: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
  };
  const replacement = {
    ...adapter,
    request: vi.fn(async () => ({})),
    call: vi.fn(adapter.call),
    check: vi.fn(adapter.check),
  };
  const effects = {
    diagnostic: vi.fn(),
    sleep: vi.fn(async () => {}),
    error: vi.fn(async () => {}),
    recover: vi.fn(async () => replacement),
  };
  const manager = new SessionLifecycle(effects);
  return { manager, adapter, wrapped: manager.wrap(context, adapter), replacement, effects };
}
test('subscriptions retain idle leases while health follows its configured interval and close disables timers', async () => {
  vi.useFakeTimers();
  const { wrapped, adapter, effects } = setup();
  await wrapped.request({ method: 'resources/subscribe', params: { uri: 'file:///subscribed' } });
  await vi.advanceTimersByTimeAsync(50);
  expect(adapter.check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10);
  expect(adapter.check).toHaveBeenCalledTimes(1);
  expect(effects.sleep).not.toHaveBeenCalled();
  await wrapped.close();
  await vi.advanceTimersByTimeAsync(120);
  expect(adapter.check).toHaveBeenCalledTimes(1);
});
test('health recovery restores subscriptions but never replays a dispatched tool', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const { wrapped, adapter, replacement, effects } = setup();
  await wrapped.request({ method: 'resources/subscribe', params: { uri: 'file:///subscribed' } });
  await expect(wrapped.call({ name: 'write', arguments: {} })).rejects.toThrow('execution failed');
  vi.mocked(adapter.check!).mockRejectedValueOnce(new Error('ping failed'));
  await vi.advanceTimersByTimeAsync(60);
  expect(effects.recover).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5);
  expect(effects.recover).toHaveBeenCalledTimes(1);
  expect(replacement.request).toHaveBeenCalledWith(
    {
      method: 'resources/subscribe',
      params: { uri: 'file:///subscribed' },
    },
    { signal: expect.any(AbortSignal) },
  );
  expect(adapter.call).toHaveBeenCalledTimes(1);
  expect(replacement.call).not.toHaveBeenCalled();
  await wrapped.close();
});
test('first catalog failure schedules recovery and closing during backoff prevents resurrection', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const { wrapped, adapter, manager, effects } = setup();
  adapter.catalog = vi.fn(async () => {
    throw new Error('unreachable');
  });
  await expect(wrapped.catalog()).rejects.toThrow('unreachable');
  expect(manager.recovery('unit-session')[0]).toMatchObject({ status: 'scheduled', attempts: 0 });
  await wrapped.close();
  await vi.advanceTimersByTimeAsync(100);
  expect(effects.recover).not.toHaveBeenCalled();
  expect(manager.recovery('unit-session')).toEqual([]);
});
test.skipIf(process.platform === 'win32')(
  'managed stdio terminates a real child and grandchild after the configured grace',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'platform-tree-'));
    const path = join(directory, 'pids.json');
    const script = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});process.stdin.resume();const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(path)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
    const transport = new ManagedStdioTransport({
      command: process.execPath,
      args: ['-e', script],
      shutdownGraceMs: 100,
    });
    try {
      await transport.start();
      let pids: number[] = [];
      await vi.waitFor(async () => {
        pids = JSON.parse(await readFile(path, 'utf8')) as number[];
        expect(pids).toHaveLength(2);
      });
      await transport.close();
      await vi.waitFor(
        () => {
          for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
        },
        { timeout: 3000 },
      );
    } finally {
      await transport.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
