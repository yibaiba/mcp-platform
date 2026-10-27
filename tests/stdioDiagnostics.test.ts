import { PassThrough } from 'node:stream';
import { getEventListeners } from 'node:events';
import { expect, test, vi } from 'vitest';
import {
  observeStdioStderr,
  STDERR_TAIL_BYTES,
} from '../apps/server/src/modules/mcp/stdioDiagnostics.js';
import { redactConnectionText } from '../apps/server/src/modules/mcp/connectionDiagnostics.js';
import { awaitConnection } from '../apps/server/src/modules/mcp/awaitConnection.js';
import { connectionInput } from '../packages/contracts/src/index.js';

test('stderr diagnostics redact split credentials and explicitly report bounded tails', () => {
  const config = connectionInput.parse({
    name: 'test',
    adapter: 'direct',
    transport: 'stdio',
    mode: 'managed',
    command: 'node',
    env: { TOKEN: 'private-environment-secret' },
  });
  const stderr = new PassThrough();
  const log = vi.fn();
  const diagnose = observeStdioStderr(stderr, {
    redact: (text) => redactConnectionText(text, config),
    log,
  });
  stderr.write('missing dependency private-environ');
  stderr.write('ment-secret\nAuthorization: Bearer confidential-header\n');
  const diagnostic = diagnose(new Error('process exited')).message;
  expect(diagnostic).toContain('missing dependency [redacted]');
  expect(diagnostic).not.toContain('private-environment-secret');
  expect(diagnostic).not.toContain('confidential-header');
  stderr.write(`${'x'.repeat(STDERR_TAIL_BYTES + 1)}\n`);
  expect(diagnose(new Error('failed')).message).toContain('单行超过 32 KiB');
  for (let index = 0; index < 40; index++) stderr.write(`${'y'.repeat(1024)}\n`);
  expect(diagnose(new Error('failed')).message).toContain('仅显示最近 32 KiB');
  stderr.end();
  expect(log.mock.calls.flat().join('\n')).not.toContain('confidential-header');
});

test('one cancelled initialization waiter leaves others running and removes its listener', async () => {
  const initialization = Promise.withResolvers<void>();
  const abort = new AbortController();
  const first = awaitConnection(initialization.promise, abort.signal);
  const second = awaitConnection(initialization.promise);
  const failure = new Error('cancel this request');
  abort.abort(failure);
  await expect(first).rejects.toBe(failure);
  expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  initialization.resolve();
  await second;
  const completed = new AbortController();
  await awaitConnection(Promise.resolve(), completed.signal);
  expect(getEventListeners(completed.signal, 'abort')).toHaveLength(0);
  completed.abort(failure);
  await expect(awaitConnection(Promise.resolve(), completed.signal)).rejects.toBe(failure);
});
