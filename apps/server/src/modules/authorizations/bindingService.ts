import { z } from 'zod';
import { connectionInput, type ConnectionInput } from '@platform/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { authorizationBindings, catalogSnapshots, connections, type Database } from '@platform/db';
import type { McpCatalog } from '@platform/mcp';
import { digest, type Vault } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import type { ConnectionContext } from '../mcp/adapter.js';
import type { ShareService } from '../shares/shareService.js';

export class BindingService {
  constructor(private readonly deps: { db: Database; vault: Vault; shares: ShareService }) {}
  async resolve(input: { ownerId: string; connectionId: string; identity: string }) {
    const id = `b_${digest(`${input.connectionId}:${input.identity}`)}`;
    await this.deps.db
      .insert(authorizationBindings)
      .values({ id, ...input })
      .onConflictDoNothing();
    const [binding] = await this.deps.db
      .select()
      .from(authorizationBindings)
      .where(
        and(eq(authorizationBindings.id, id), eq(authorizationBindings.ownerId, input.ownerId)),
      );
    if (!binding || binding.revoked)
      throw new AppError('BINDING_REVOKED', '上游授权绑定已撤销，请重新授权', 403);
    return binding;
  }
  async owned(ownerId: string, id: string) {
    const [row] = await this.deps.db
      .select()
      .from(authorizationBindings)
      .where(and(eq(authorizationBindings.ownerId, ownerId), eq(authorizationBindings.id, id)));
    if (!row) throw new AppError('NOT_FOUND', '授权绑定不存在', 404);
    return row;
  }
  async credentials(ownerId: string, id: string, input: unknown) {
    const row = await this.owned(ownerId, id);
    if (row.identity === 'default')
      throw new AppError('IDENTITY_MODE', '共享连接凭证请在连接配置保存；请先选择独立身份');
    const [connection] = await this.deps.db
      .select()
      .from(connections)
      .where(eq(connections.id, row.connectionId));
    if (!connection) throw new AppError('NOT_FOUND', '连接不存在', 404);
    const access = await this.deps.shares.connection(ownerId, row.connectionId);
    if (access.share?.credentialMode === 'owner')
      throw new AppError('SHARE_OWNER_CREDENTIALS', '共享凭证由所有者管理', 403);
    const config = access.share
      ? this.deps.shares.config(ownerId, access.share)
      : connectionInput.parse(
          this.deps.vault.open(connection.config, `${connection.ownerId}:${row.connectionId}`),
        );
    const value = z
      .object({
        revision: z.number().int().positive().optional(),
        headers: z.record(z.string(), z.string()).default({}),
        env: z.record(z.string(), z.string()).default({}),
        openapi: connectionInput.shape.openapi.unwrap().shape.credentials.optional(),
      })
      .strict()
      .parse(input);
    if (value.revision !== undefined && value.revision !== row.revision)
      throw new AppError('REVISION_CONFLICT', '绑定凭证已变化，请重新加载', 409);
    const permittedHeaders = new Set(
      [...config.credentialHeaders, 'authorization', 'cookie'].map((key) => key.toLowerCase()),
    );
    if (
      Object.keys(value.env).some((key) => !config.credentialEnv.includes(key)) ||
      Object.keys(value.headers).some((key) => !permittedHeaders.has(key.toLowerCase()))
    )
      throw new AppError('IDENTITY_FIELDS', '独立凭证只能覆盖连接声明的身份字段');
    const { revision: _revision, ...credentials } = value;
    const updated = await this.deps.db
      .update(authorizationBindings)
      .set({
        revision: sql`${authorizationBindings.revision} + 1`,
        credentials: this.deps.vault.seal(credentials, `identity:${ownerId}:${id}`),
        revoked: false,
      })
      .where(
        and(eq(authorizationBindings.id, row.id), eq(authorizationBindings.revision, row.revision)),
      )
      .returning({ id: authorizationBindings.id });
    if (!updated.length) throw new AppError('REVISION_CONFLICT', '绑定凭证已变化，请重新加载', 409);
    await this.deps.db.delete(catalogSnapshots).where(eq(catalogSnapshots.bindingId, row.id));
  }
  async configuration(
    binding: typeof authorizationBindings.$inferSelect,
    config: ConnectionInput,
    isolate = false,
  ) {
    if (
      (!isolate && !binding.credentials && !binding.identity.startsWith('profile:')) ||
      binding.identity === 'default'
    )
      return config;
    const stored = binding.credentials
      ? this.deps.vault.open<{
          headers: Record<string, string>;
          env: Record<string, string>;
          openapi?: NonNullable<ConnectionInput['openapi']>['credentials'];
        }>(binding.credentials, `identity:${binding.ownerId}:${binding.id}`)
      : undefined;
    const identityHeaders = new Set([
      'authorization',
      'cookie',
      'proxy-authorization',
      ...config.credentialHeaders.map((h) => h.toLowerCase()),
    ]);
    return {
      ...config,
      credentialHeaders: [
        ...new Set([
          ...config.credentialHeaders,
          ...Object.keys(config.headers).filter((h) =>
            /^(authorization|cookie|proxy-authorization)$/i.test(h),
          ),
        ]),
      ],
      headers: {
        ...Object.fromEntries(
          Object.entries(config.headers).filter(([h]) => !identityHeaders.has(h.toLowerCase())),
        ),
        ...stored?.headers,
      },
      env: {
        ...Object.fromEntries(
          Object.entries(config.env).filter(([k]) => !config.credentialEnv.includes(k)),
        ),
        ...stored?.env,
      },
      openapi: config.openapi
        ? { ...config.openapi, credentials: stored?.openapi ?? {} }
        : undefined,
    };
  }
  async invalidate(context: ConnectionContext) {
    await this.deps.db
      .delete(catalogSnapshots)
      .where(eq(catalogSnapshots.bindingId, context.bindingId!));
    await this.deps.db
      .update(authorizationBindings)
      .set({ revision: sql`${authorizationBindings.revision} + 1` })
      .where(
        and(
          eq(authorizationBindings.id, context.bindingId!),
          eq(authorizationBindings.ownerId, context.ownerId),
        ),
      );
  }
  async assertCredentials(context: ConnectionContext) {
    if ((context.credentialScope?.identity ?? context.identity) === 'default') return;
    const config = context.config;
    const missing =
      config.transport === 'stdio'
        ? config.credentialEnv.filter((key) => config.env[key] === undefined)
        : config.credentialHeaders.filter(
            (key) =>
              !Object.keys(config.headers).some((h) => h.toLowerCase() === key.toLowerCase()),
          );
    if (missing.length)
      throw new AppError(
        'IDENTITY_CREDENTIAL_REQUIRED',
        `当前身份缺少凭证字段：${missing.join(', ')}`,
        401,
      );
  }
  list(ownerId: string, connectionId: string) {
    return this.deps.db
      .select({
        id: authorizationBindings.id,
        identity: authorizationBindings.identity,
        revoked: authorizationBindings.revoked,
      })
      .from(authorizationBindings)
      .where(
        and(
          eq(authorizationBindings.ownerId, ownerId),
          eq(authorizationBindings.connectionId, connectionId),
        ),
      );
  }
  async save(context: ConnectionContext, catalog: McpCatalog) {
    if (!context.bindingId || !context.capabilityKey) return;
    const id = `${context.bindingId}:${context.capabilityKey}`;
    const encrypted = this.deps.vault.seal(catalog, `catalog:${context.ownerId}:${id}`);
    await this.deps.db
      .insert(catalogSnapshots)
      .values({
        id,
        ownerId: context.ownerId,
        connectionId: context.id,
        bindingId: context.bindingId,
        capabilityKey: context.capabilityKey,
        encrypted,
      })
      .onConflictDoUpdate({
        target: catalogSnapshots.id,
        set: { encrypted, updatedAt: new Date() },
      });
  }
  async snapshot(context: ConnectionContext) {
    const id = `${context.bindingId}:${context.capabilityKey}`;
    const [row] = await this.deps.db
      .select()
      .from(catalogSnapshots)
      .where(and(eq(catalogSnapshots.id, id), eq(catalogSnapshots.ownerId, context.ownerId)));
    return row
      ? this.deps.vault.open<McpCatalog>(row.encrypted, `catalog:${context.ownerId}:${id}`)
      : undefined;
  }
}
