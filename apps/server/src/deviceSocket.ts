import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { Services } from './services.js';
export function attachDeviceSocket(server: Server, services: Services) {
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/api/v1/devices/channel') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    if (!token || request.headers.origin) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    void services.devices
      .authenticate(token)
      .then((device) => {
        sockets.handleUpgrade(request, socket, head, (ws) => services.broker.attach(device.id, ws));
      })
      .catch(() => socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'));
  });
  return sockets;
}
