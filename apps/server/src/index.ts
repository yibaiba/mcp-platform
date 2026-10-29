import { startUpdateChecks } from './modules/updates/scheduler.js';
import { config as loadEnv } from 'dotenv';
import { serve } from '@hono/node-server';
import { createAuth } from '@platform/auth';
import {
  calls,
  connections,
  connectionShares,
  createDatabase,
  transfers,
  configManifests,
  user,
} from '@platform/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { envSchema, platformRoot } from './config.js';
import { createServices } from './services.js';
import { createApp } from './app.js';
import { attachDeviceSocket } from './deviceSocket.js';
import { mountWeb } from './web.js';
import { readFile } from 'node:fs/promises';
import { applyStartupManifest } from './modules/configuration/startup.js';
import { startManifestReconciliation } from './modules/configuration/lifecycle.js';
import { startRetention } from './modules/activity/retention.js';
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
  providers: config.AUTH_PROVIDERS,
});
const services = createServices(db, config);
const stopUpdates = await startUpdateChecks({
  db,
  clock: {
    now: () => new Date(),
    every: (fn, ms) => {
      const timer = setInterval(fn, ms);
      timer.unref();
      return () => clearInterval(timer);
    },
  },
  packageCheck: (owner, id) => services.packageUpdates.check(owner, id),
  platformCheck: () => services.platformUpdates.check(),
  failed: () => services.logger.report('UPDATE_CHECK_FAILED'),
});
const stopRetention = startRetention({
  db,
  logger: services.logger,
  callDays: config.CALL_RETENTION_DAYS,
  logDays: config.LOG_RETENTION_DAYS,
});
await db
  .update(calls)
  .set({ status: 'unknown', error: '平台重启；执行结果未知，不会自动重放', endedAt: new Date() })
  .where(inArray(calls.status, ['running', 'waiting']));
await db
  .update(connections)
  .set({ status: 'disconnected' })
  .where(eq(connections.status, 'connected'));
await db
  .update(connectionShares)
  .set({ status: 'disconnected' })
  .where(eq(connectionShares.status, 'connected'));
await db
  .update(transfers)
  .set({ status: 'unknown', error: '平台重启；请检查目标文件' })
  .where(eq(transfers.status, 'streaming'));
await services.pi.recover();
await services.requests.recover();
await services.interactions.recover();
await services.rest.recover();
await services.discovery.recover();
await applyStartupManifest({
  file: config.CONFIG_MANIFEST_FILE,
  ownerEmail: config.CONFIG_MANIFEST_OWNER,
  read: (path) => readFile(resolve(platformRoot, path), 'utf8'),
  owner: async (email) =>
    (
      await db
        .select({ id: user.id })
        .from(user)
        .where(and(eq(user.email, email.toLowerCase()), eq(user.enabled, true)))
    )[0]?.id,
  manifests: services.manifests,
});
const stopManifests = startManifestReconciliation({
  manifests: services.manifests,
  logger: services.logger,
  owners: async () =>
    (
      await db
        .selectDistinct({ ownerId: configManifests.ownerId })
        .from(configManifests)
        .innerJoin(user, eq(user.id, configManifests.ownerId))
        .where(eq(user.enabled, true))
    ).map((row) => row.ownerId),
});
const app = createApp({ db, auth, config, services });
if (process.env.NODE_ENV === 'production')
  await mountWeb(app, resolve(platformRoot, 'apps/web/dist'));
const server = serve({ fetch: app.fetch, port: config.PORT });
const sockets = attachDeviceSocket(server as Server, services);
await services.logger.write({ level: 'info', event: 'server_started' });
console.log(
  `MCP Platform listening on ${config.PORT}; Pi MCP bridge available; built-in agent tasks ${config.PI_ENABLED === 'true' ? 'enabled' : 'disabled'}`,
);
async function shutdown() {
  await stopUpdates();
  await stopRetention();
  await stopManifests();
  server.close();
  services.broker.close();
  await services.local.close();
  sockets.close();
  await services.gateway.close();
  await services.connections.shutdown();
  await services.rest.close();
  await services.pi.close();
  await services.network.close();
  await services.logger.write({ level: 'info', event: 'server_stopped' });
  await services.discovery.close();
  await services.logger.drain();
  await pool.end();
}
let stopping = false;
function beginShutdown() {
  if (stopping) return;
  stopping = true;
  void shutdown().catch(() => {
    services.logger.report('SERVER_SHUTDOWN_FAILED');
    process.exitCode = 1;
  });
}
process.once('SIGTERM', beginShutdown);
process.once('SIGINT', beginShutdown);
