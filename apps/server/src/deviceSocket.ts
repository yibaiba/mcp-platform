import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import {
  DEVICE_AUTH_LIFETIME_MS,
  DEVICE_AUTH_MAX_BYTES,
  deviceAuthAbort,
  deviceAuthResponse,
  type DeviceAuthChallenge,
} from '@platform/contracts';
import { secretToken } from './shared/crypto.js';
import type { Services } from './services.js';
function authenticateSocket(ws: WebSocket, services: Services) {
  const challenge: DeviceAuthChallenge = {
    type: 'auth.challenge',
    v: 1,
    nonce: secretToken(),
    expiresAt: new Date(Date.now() + DEVICE_AUTH_LIFETIME_MS).toISOString(),
    // Public origin the MAC is bound to; connectors compare it with --server for a clear error.
    origin: services.devices.platformOrigin,
  };
  let consumed = false;
  let failed = false;
  const fail = (reason?: string) => {
    if (failed) return;
    // Reason codes only: never log the nonce, MAC or any device secret.
    if (reason) services.logger.report(`DEVICE_AUTH_${reason}`);
    failed = true;
    clearTimeout(timer);
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({ type: 'auth.failure', v: 1, error: 'Device authentication failed' }),
      );
      ws.close(1008, 'Device authentication failed');
    }
  };
  const timer = setTimeout(() => fail('TIMEOUT'), DEVICE_AUTH_LIFETIME_MS);
  ws.on('error', () => ws.terminate());
  ws.once('close', () => {
    failed = true;
    clearTimeout(timer);
  });
  const receive = (data: RawData, binary: boolean) => {
    if (consumed) return fail('UNEXPECTED_MESSAGE');
    consumed = true;
    // Bound the authentication envelope before converting or parsing JSON.
    const length = Array.isArray(data)
      ? data.reduce((sum, part) => sum + part.length, 0)
      : data.byteLength;
    if (binary || length > DEVICE_AUTH_MAX_BYTES) return fail('MALFORMED');
    void (async () => {
      let message: unknown;
      try {
        message = JSON.parse((Array.isArray(data) ? Buffer.concat(data) : data).toString());
      } catch {
        return fail('MALFORMED');
      }
      // Newer connectors abort instead of signing when --server differs from PUBLIC_URL.
      const abort = deviceAuthAbort.safeParse(message);
      if (abort.success) return fail('ORIGIN_MISMATCH');
      const parsed = deviceAuthResponse.safeParse(message);
      if (!parsed.success) return fail('MALFORMED');
      const response = parsed.data;
      await services.devices.authenticate({
        challenge,
        response,
        register: () => {
          if (failed || ws.readyState !== ws.OPEN || Date.now() >= Date.parse(challenge.expiresAt))
            return fail('REGISTER_LATE');
          clearTimeout(timer);
          ws.removeListener('message', receive);
          services.broker.attach(response.deviceId, ws);
          ws.send(JSON.stringify({ type: 'auth.success', v: 1 }));
        },
      });
    })().catch(() => fail());
  };
  ws.on('message', receive);
  ws.send(JSON.stringify(challenge));
}
export function attachDeviceSocket(server: Server, services: Services) {
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/api/v1/devices/channel') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    if (request.headers.authorization !== undefined || request.headers.origin !== undefined) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => authenticateSocket(ws, services));
  });
  return sockets;
}
