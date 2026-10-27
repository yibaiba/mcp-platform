import { config as dotenv } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { createAuth } from '../packages/auth/src/index.js';
import { createDatabase, user } from '../packages/db/src/index.js';
import { eq } from 'drizzle-orm';
import { envSchema } from '../apps/server/src/config.js';
import { createApp } from '../apps/server/src/app.js';
import { createServices } from '../apps/server/src/services.js';
import { attachDeviceSocket } from '../apps/server/src/deviceSocket.js';
dotenv({ path: '.env', quiet: true });
export async function harness() {
  if (!process.env.DATABASE_URL)
    throw new Error('Tests require a migrated PostgreSQL DATABASE_URL');
  const directory = await mkdtemp(join(tmpdir(), 'platform-test-'));
  const { db, pool } = createDatabase(process.env.DATABASE_URL);
  const config = envSchema.parse({
    ...process.env,
    DATA_DIR: directory,
    PI_ENABLED: 'false',
    PI_MODEL_PROVIDER: undefined,
    PI_MODEL_ID: undefined,
    ALLOW_REGISTRATION: 'true',
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PI_MCP_ADAPTER_OAUTH_FILE_KEY: randomBytes(32).toString('base64'),
    PUBLIC_URL: 'http://localhost:4300',
    WEB_ORIGIN: 'http://localhost:4301',
  });
  const server = serve({ fetch: (request, env) => app.fetch(request, env), port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  const baseURL = `http://localhost:${address.port}`;
  config.PUBLIC_URL = baseURL;
  const auth = createAuth({
    db,
    baseURL,
    webOrigin: config.WEB_ORIGIN,
    secret: config.BETTER_AUTH_SECRET,
    registration: true,
  });
  const services = createServices(db, config);
  const app = createApp({ db, auth, config, services });
  const sockets = attachDeviceSocket(server as Server, services);
  const owners: string[] = [];
  async function signup() {
    const response = await app.request('/api/v1/auth/sign-up/email', {
      method: 'POST',
      headers: { Origin: config.WEB_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Integration',
        email: `${randomUUID()}@example.test`,
        password: randomBytes(16).toString('hex'),
      }),
    });
    const data = (await response.json()) as { user?: { id: string }; message?: string };
    if (!response.ok || !data.user)
      throw new Error(`Sign up failed: ${response.status} ${data.message}`);
    owners.push(data.user.id);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    return {
      ownerId: data.user.id,
      cookie,
      request: (path: string, options: RequestInit = {}) =>
        app.request(`/api/v1${path}`, {
          ...options,
          headers: {
            Cookie: cookie,
            Origin: config.WEB_ORIGIN,
            'Content-Type': 'application/json',
            ...options.headers,
          },
        }),
    };
  }
  return {
    app,
    services,
    db,
    directory,
    baseURL,
    config,
    signup,
    async close() {
      services.broker.close();
      sockets.close();
      await services.pi.close();
      await services.gateway.close();
      await services.connections.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const id of owners) await db.delete(user).where(eq(user.id, id));
      await pool.end();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
