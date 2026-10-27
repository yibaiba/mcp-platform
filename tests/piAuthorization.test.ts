import { expect, test } from 'vitest';
import { AuthorizationCoordinator } from '../integrations/pi/src/authorizationCoordinator.js';
test('Pi authorization serializes one binding, permits another, and cancellation releases queued workers', async () => {
  const coordinator = new AuthorizationCoordinator();
  const first = await coordinator.acquire('binding-a', new AbortController().signal);
  const cancelled = new AbortController();
  const waiting = coordinator.acquire('binding-a', cancelled.signal);
  const failure = expect(waiting).rejects.toThrow('cancelled');
  cancelled.abort(new Error('cancelled'));
  await failure;
  const other = await coordinator.acquire('binding-b', new AbortController().signal);
  other.release();
  let entered = false;
  const next = coordinator.acquire('binding-a', new AbortController().signal).then((lease) => {
    entered = true;
    return lease;
  });
  await Promise.resolve();
  expect(entered).toBe(false);
  first.release();
  (await next).release();
});
