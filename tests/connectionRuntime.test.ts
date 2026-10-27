import { expect, test, vi } from 'vitest';
import { ConnectionRuntime } from '../apps/server/src/modules/mcp/connectionRuntime.js';
import { connectionInput } from '../packages/contracts/src/index.js';
import type { ConnectionAdapter } from '../apps/server/src/modules/mcp/adapter.js';

const context = {
  id: 'connection',
  ownerId: 'owner',
  config: connectionInput.parse({
    name: 'test',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: 'http://localhost/mcp',
  }),
};
function adapter(close = vi.fn(async () => {})): ConnectionAdapter {
  return {
    status: () => 'connected',
    discover: async () => [],
    catalog: async () => ({
      tools: [],
      prompts: [],
      resources: [],
      templates: [],
      capabilities: {},
    }),
    request: async () => {
      throw new Error('Unexpected content operation in runtime test');
    },
    watch: () => () => {},
    call: async () => ({ content: [] }),
    close,
  };
}

test('concurrent acquisitions share one initialization and shutdown closes it once', async () => {
  const client = adapter();
  const factory = vi.fn(async () => client);
  const runtime = new ConnectionRuntime(factory);
  const first = runtime.acquire(context);
  const second = runtime.acquire(context);
  expect(second).toBe(first);
  await Promise.all([runtime.adapter(first), runtime.adapter(second)]);
  expect(factory).toHaveBeenCalledTimes(1);
  await runtime.shutdown();
  expect(client.close).toHaveBeenCalledTimes(1);
});

test('a replacement waits for previous cleanup and rejects late discovery writes', async () => {
  const release = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  const oldClient = adapter(
    vi.fn(async () => {
      closing.resolve();
      await release.promise;
    }),
  );
  const newClient = adapter();
  const factory = vi.fn().mockResolvedValueOnce(oldClient).mockResolvedValueOnce(newClient);
  const runtime = new ConnectionRuntime(factory);
  const old = runtime.acquire(context);
  await runtime.adapter(old);
  const stop = runtime.invalidate(context.id);
  const replacement = runtime.acquire(context);
  const ready = runtime.adapter(replacement);
  await closing.promise;
  expect(factory).toHaveBeenCalledTimes(1);
  const staleWrite = vi.fn(async () => {});
  const write = runtime.write(old, staleWrite);
  release.resolve();
  await stop.closed;
  expect(await ready).toBe(newClient);
  expect(await write).toBe(false);
  expect(staleWrite).not.toHaveBeenCalled();
  expect(old.abort.signal.aborted).toBe(true);
  await runtime.shutdown();
});

test('a failed factory exposes its failure and a later acquisition can initialize again', async () => {
  const failure = new Error('initialization failed');
  const client = adapter();
  const runtime = new ConnectionRuntime(
    vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(client),
  );
  const failed = runtime.acquire(context);
  await expect(runtime.adapter(failed)).rejects.toBe(failure);
  await runtime.invalidate(context.id).closed;
  const next = runtime.acquire(context);
  expect(await runtime.adapter(next)).toBe(client);
  await runtime.shutdown();
});

test('shutdown attempts every close and exposes cleanup failures', async () => {
  const failure = new Error('cleanup failed');
  const close = vi.fn(async () => {
    throw failure;
  });
  const healthy = adapter();
  const runtime = new ConnectionRuntime(
    vi.fn().mockResolvedValueOnce(adapter(close)).mockResolvedValueOnce(healthy),
  );
  await runtime.adapter(runtime.acquire(context));
  await runtime.adapter(runtime.acquire({ ...context, id: 'other' }));
  await expect(runtime.shutdown()).rejects.toMatchObject({ errors: [failure] });
  expect(healthy.close).toHaveBeenCalledTimes(1);
});

test('a superseded initialization failure cannot evict the replacement', async () => {
  const initialization = Promise.withResolvers<ConnectionAdapter>();
  const client = adapter();
  const runtime = new ConnectionRuntime(
    vi.fn().mockReturnValueOnce(initialization.promise).mockResolvedValueOnce(client),
  );
  const old = runtime.acquire(context);
  const pending = runtime.adapter(old);
  const failure = new Error('late initialization failure');
  const rejected = expect(pending).rejects.toBe(failure);
  const stop = runtime.invalidate(context.id);
  const replacement = runtime.acquire(context);
  initialization.reject(failure);
  await rejected;
  await stop.closed;
  expect(await runtime.adapter(replacement)).toBe(client);
  expect(runtime.current(replacement)).toBe(true);
  expect(
    await runtime.write(old, async () => {
      throw new Error('stale write');
    }),
  ).toBe(false);
  await runtime.shutdown();
});
