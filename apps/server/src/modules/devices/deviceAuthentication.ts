import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  deviceAuthInput,
  type DeviceAuthChallenge,
  type DeviceAuthResponse,
} from '@platform/contracts';
export function verifyDeviceMac(input: {
  secret: string;
  platformOrigin: string;
  challenge: DeviceAuthChallenge;
  response: DeviceAuthResponse;
}) {
  const expected = createHmac('sha256', Buffer.from(input.secret, 'base64url'))
    .update(
      deviceAuthInput({
        ...input.response,
        platformOrigin: input.platformOrigin,
        challenge: input.challenge,
      }),
    )
    .digest();
  const received = Buffer.from(input.response.mac, 'base64url');
  return received.length === expected.length && timingSafeEqual(expected, received);
}
// All credential transitions and final channel registration share one per-device queue.
export class DeviceSerial {
  private readonly pending = new Map<string, Promise<unknown>>();
  async run<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.pending.set(id, next);
    try {
      return await next;
    } finally {
      if (this.pending.get(id) === next) this.pending.delete(id);
    }
  }
}
