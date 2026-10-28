import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { configSecrets, type Database } from '@platform/db';
import type { Vault } from '../../shared/crypto.js';
import { DeploymentPending } from './values.js';
export const secretInput = z
  .object({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/), value: z.string() })
  .strict();
export class ConfigSecrets {
  constructor(
    private readonly deps: {
      db: Database;
      vault: Vault;
      changed: (ownerId: string) => Promise<void>;
    },
  ) {}
  list(ownerId: string) {
    return this.deps.db
      .select({ name: configSecrets.name, revision: configSecrets.revision })
      .from(configSecrets)
      .where(eq(configSecrets.ownerId, ownerId));
  }
  async save(ownerId: string, input: unknown) {
    const { name, value } = secretInput.parse(input);
    await this.deps.db
      .insert(configSecrets)
      .values({
        ownerId,
        name,
        encrypted: this.deps.vault.seal(value, `secret:${ownerId}:${name}`),
      })
      .onConflictDoUpdate({
        target: [configSecrets.ownerId, configSecrets.name],
        set: {
          encrypted: this.deps.vault.seal(value, `secret:${ownerId}:${name}`),
          revision: sql`${configSecrets.revision} + 1`,
        },
      });
    await this.deps.changed(ownerId);
    return { name };
  }
  async read(ownerId: string, name: string) {
    const [row] = await this.deps.db
      .select()
      .from(configSecrets)
      .where(and(eq(configSecrets.ownerId, ownerId), eq(configSecrets.name, name)));
    if (!row) throw new DeploymentPending(`尚未配置秘密：${name}`);
    return this.deps.vault.open<string>(row.encrypted, `secret:${ownerId}:${name}`);
  }
}
