import { afterEach, expect, test, vi } from 'vitest';
import { RecoverySchedule } from '../apps/server/src/modules/mcp/lifecycle/recoverySchedule.js';
import { AppError } from '../apps/server/src/shared/errors.js';
afterEach(() => vi.useRealTimers());
function setup(random = 0.5) {
  vi.useFakeTimers();
  const effects = {
    initialIntervalMs: 5_000,
    maxIntervalMs: 300_000,
    recover: vi.fn(async () => {}),
    report: vi.fn(async () => {}),
    redact: () => 'redacted failure',
    random: () => random,
  };
  return { effects, recovery: new RecoverySchedule(effects) };
}
test('retries double to the configured maximum without an attempt cap and reset on success', async () => {
  const { effects, recovery } = setup();
  effects.recover.mockRejectedValue(new Error('offline'));
  recovery.failed(new Error('offline'));
  for (const delay of [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000]) {
    expect(Date.parse(recovery.state.nextAt!) - Date.now()).toBe(delay);
    await vi.advanceTimersByTimeAsync(delay);
  }
  expect(recovery.state.attempts).toBe(8);
  effects.recover.mockResolvedValue();
  await vi.advanceTimersByTimeAsync(300000);
  expect(recovery.state).toEqual({ attempts: 0, status: 'idle' });
  recovery.failed(new Error('offline again'));
  expect(Date.parse(recovery.state.nextAt!) - Date.now()).toBe(5000);
  recovery.close();
});
test.each([
  [0, 4000],
  [1, 6000],
])('jitter sample %s produces delay %s', (random, delay) => {
  const { recovery } = setup(random);
  recovery.failed(new Error('offline'));
  expect(Date.parse(recovery.state.nextAt!) - Date.now()).toBe(delay);
  recovery.close();
});
test('authorization and invalid configuration remain blocked without a recovery timer', async () => {
  const { effects, recovery } = setup();
  recovery.failed(new AppError('AUTH_REQUIRED', 'authorize first', 401));
  expect(recovery.state).toMatchObject({ status: 'blocked', error: 'redacted failure' });
  await vi.advanceTimersByTimeAsync(300000);
  expect(effects.recover).not.toHaveBeenCalled();
  recovery.close();
});
test('Pi authorization and wrapped process configuration errors do not retry', async () => {
  const { effects, recovery } = setup();
  for (const error of [
    Object.assign(new Error('authorize'), { code: 'auth_required' }),
    new Error('startup failed', {
      cause: Object.assign(new Error('missing executable'), { code: 'ENOENT' }),
    }),
  ]) {
    recovery.failed(error);
    expect(recovery.state.status).toBe('blocked');
  }
  await vi.advanceTimersByTimeAsync(300000);
  expect(effects.recover).not.toHaveBeenCalled();
  recovery.close();
});
