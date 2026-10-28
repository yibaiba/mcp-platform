import { config as loadEnv } from 'dotenv';
import { serve } from '@hono/node-server';
import { createAuth } from '@platform/auth';
import { calls, connections, createDatabase, transfers } from '@platform/db';
import { eq, inArray } from 'drizzle-orm';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { envSchema, platformRoot } from './config.js';
import { createServices } from './services.js';
import { createApp } from './app.js';
import { attachDeviceSocket } from './deviceSocket.js';
import { mountWeb } from './web.js';
loadEnv({ path: resolve(platformRoot, '.env') });
const parsedConfig = envSchema.parse(process.env);
const config = { ...parsedConfig, DATA_DIR: resolve(platformRoot, parsedConfig.DATA_DIR) };
const { db, pool } = createDatabase(config.DATABASE_URL);
const auth = createAuth({
  db,
  baseURL: config.PUBLIC_URL,
  webOrigin: config.WEB_ORIGIN,
  secret: config.BETTER_AUTH_SECRET,
  registration: config.ALLOW_REGISTRATION === 'true',
});
const services = createServices(db, config);
await db
  .update(calls)
  .set({ status: 'unknown', error: '平台重启；执行结果未知，不会自动重放', endedAt: new Date() })
  .where(inArray(calls.status, ['running', 'waiting']));
await db
  .update(connections)
  .set({ status: 'disconnected' })
  .where(eq(connections.status, 'connected'));
await db
  .update(transfers)
  .set({ status: 'unknown', error: '平台重启；请检查目标文件' })
  .where(eq(transfers.status, 'streaming'));
await services.pi.recover();
await services.requests.recover();
await services.interactions.recover();
const app = createApp({ db, auth, config, services });
if (process.env.NODE_ENV === 'production')
  await mountWeb(app, resolve(platformRoot, 'apps/web/dist'));
const server = serve({ fetch: app.fetch, port: config.PORT });
const sockets = attachDeviceSocket(server as Server, services);
console.log(
  `MCP Platform listening on ${config.PORT}; Pi MCP bridge available; built-in agent tasks ${config.PI_ENABLED === 'true' ? 'enabled' : 'disabled'}`,
);
async function shutdown() {
  server.close();
  services.broker.close();
  sockets.close();
  await services.pi.close();
  await services.gateway.close();
  await services.connections.shutdown();
  await pool.end();
}
let stopping = false;
function beginShutdown() {
  if (stopping) return;
  stopping = true;
  void shutdown().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
process.once('SIGTERM', beginShutdown);
process.once('SIGINT', beginShutdown);
