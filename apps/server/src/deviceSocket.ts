import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import {
  DEVICE_AUTH_LIFETIME_MS,
  DEVICE_AUTH_MAX_BYTES,
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
  };
  let consumed = false;
  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    clearTimeout(timer);
    if (ws.readyState === ws.OPEN) {
      ws.send(
        JSON.stringify({ type: 'auth.failure', v: 1, error: 'Device authentication failed' }),
      );
      ws.close(1008, 'Device authentication failed');
    }
  };
  const timer = setTimeout(fail, DEVICE_AUTH_LIFETIME_MS);
  ws.on('error', () => ws.terminate());
  ws.once('close', () => {
    failed = true;
    clearTimeout(timer);
  });
  const receive = (data: RawData, binary: boolean) => {
    if (consumed) return fail();
    consumed = true;
    // Bound the authentication envelope before converting or parsing JSON.
    const length = Array.isArray(data)
      ? data.reduce((sum, part) => sum + part.length, 0)
      : data.byteLength;
    if (binary || length > DEVICE_AUTH_MAX_BYTES) return fail();
    void (async () => {
      const response = deviceAuthResponse.parse(
        JSON.parse((Array.isArray(data) ? Buffer.concat(data) : data).toString()),
      );
      await services.devices.authenticate({
        challenge,
        response,
        register: () => {
          if (failed || ws.readyState !== ws.OPEN || Date.now() >= Date.parse(challenge.expiresAt))
            return fail();
          clearTimeout(timer);
          ws.removeListener('message', receive);
          services.broker.attach(response.deviceId, ws);
          ws.send(JSON.stringify({ type: 'auth.success', v: 1 }));
        },
      });
    })().catch(fail);
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
