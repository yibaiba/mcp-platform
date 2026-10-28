import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
export const { WebSocket } = createRequire(new URL('../apps/server/package.json', import.meta.url))(
  'ws',
) as typeof import('ws');
import {
  deviceAuthChallenge,
  deviceAuthInput,
  type DeviceAuthChallenge,
} from '../packages/contracts/src/index.js';
export function authResponse(
  device: { deviceId: string; deviceSecret: string; credentialVersion: number },
  challenge: DeviceAuthChallenge,
  origin: string,
) {
  return {
    type: 'auth.response',
    v: 1,
    deviceId: device.deviceId,
    credentialVersion: device.credentialVersion,
    mac: createHmac('sha256', Buffer.from(device.deviceSecret, 'base64url'))
      .update(deviceAuthInput({ ...device, platformOrigin: origin, challenge }))
      .digest('base64url'),
  };
}
export async function authPeer(origin: string, headers?: Record<string, string>) {
  const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/api/v1/devices/channel', { headers });
  const messages: unknown[] = [];
  let resolve: ((value: unknown) => void) | undefined;
  const closed = new Promise<number>((done) => ws.once('close', done));
  ws.on('error', () => undefined);
  ws.on('message', (raw) => {
    const value: unknown = JSON.parse(raw.toString());
    if (resolve) {
      const done = resolve;
      resolve = undefined;
      done(value);
    } else messages.push(value);
  });
  const next = () =>
    messages.length
      ? Promise.resolve(messages.shift())
      : new Promise<unknown>((done) => {
          resolve = done;
        });
  const challenge = deviceAuthChallenge.parse(await next());
  return { ws, challenge, next, closed, send: (value: unknown) => ws.send(JSON.stringify(value)) };
}
