import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { eq } from 'drizzle-orm';
import { user } from '../packages/db/src/index.js';
import { platformRoot } from '../apps/server/src/config.js';
import { loadConfig } from '../apps/server/src/bootstrap.js';
import { createServices } from '../apps/server/src/services.js';
loadEnv({ path: resolve(platformRoot, '.env'), quiet: true });
const [action, email, fileOrName] = process.argv.slice(2);
if (!['preview', 'apply', 'status', 'export'].includes(action ?? '') || !email || !fileOrName)
  throw new Error(
    'Usage: pnpm config:manifest <preview|apply|status|export> <owner-email> <JSON-file|manifest-name>',
  );
const { config, db, pool } = await loadConfig();
const services = createServices(db, config);
try {
  const [owner] = await db.select().from(user).where(eq(user.email, email.trim().toLowerCase()));
  if (!owner?.enabled)
    throw new Error('The explicitly selected owner does not exist or is disabled');
  const input =
    action === 'preview' || action === 'apply'
      ? (JSON.parse(await readFile(resolve(fileOrName), 'utf8')) as unknown)
      : undefined;
  const result =
    action === 'preview'
      ? await services.manifests.preview(owner.id, input)
      : action === 'apply'
        ? await services.manifests.apply(owner.id, input)
        : action === 'export'
          ? await services.configExport.export(owner.id, fileOrName)
          : await services.manifests.status(owner.id, fileOrName);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await services.manifests.close();
  services.broker.close();
  await services.local.close();
  await services.gateway.close();
  await services.connections.shutdown();
  await services.pi.close();
  await services.logger.drain();
  await pool.end();
}
