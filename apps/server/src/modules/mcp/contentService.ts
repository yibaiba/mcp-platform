import type { DiagnosticLogger } from '../activity/systemLogger.js';
import { projectContent } from '../catalog/projection.js';
import { currentExecution } from './executionContext.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { mcpEntries, tools, type Database } from '@platform/db';
import { UriTemplate } from '@modelcontextprotocol/server';
import {
  GetPromptResultSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpOperation, McpRequestOptions } from '@platform/mcp';
import { AppError } from '../../shared/errors.js';
import type { ProfileService, Principal } from '../agent-profiles/profileService.js';
import type { ConnectionService } from './connectionService.js';
import { catalogEntries } from './catalogEntries.js';
import { scopedUri, scopeResult, originalUri } from './catalogEntries.js';
import type { ShareAccess } from '../shares/shareAccess.js';

export type ContentEntry = typeof mcpEntries.$inferSelect & { callerId?: string };
export type ContentAccess = { ownerId: string; profileId?: string; principal?: Principal };

export class ContentService {
  constructor(
    private readonly deps: {
      db: Database;
      logger: DiagnosticLogger;
      profiles: ProfileService;
      connections: ConnectionService;
      shares: ShareAccess;
    },
  ) {}
  async requestable(access: ContentAccess) {
    return (await this.deps.profiles.owned(access.ownerId, access.profileId!)).requestable
      .contentIds;
  }
  async requestableCatalog(access: ContentAccess) {
    const profile = await this.deps.profiles.owned(access.ownerId, access.profileId!);
    const ids = profile.requestable.contentIds;
    const rows = await this.deps.db
      .select()
      .from(mcpEntries)
      .where(await this.deps.shares.resourceFilter(access.ownerId, 'contentIds'));
    return projectContent(
      (
        await this.scopedCatalog(
          access.ownerId,
          rows.filter((row) => ids.includes(row.id)),
        )
      ).filter((row) => ids.includes(row.id)),
      profile.catalog,
    );
  }
  async catalog(access: ContentAccess, connectionId?: string) {
    if (access.principal)
      await this.deps.profiles.authenticate(access.principal.profileId, access.principal.token);
    const rows = await this.deps.db
      .select()
      .from(mcpEntries)
      .where(
        and(
          await this.deps.shares.resourceFilter(access.ownerId, 'contentIds'),
          connectionId ? eq(mcpEntries.connectionId, connectionId) : undefined,
        ),
      );
    const profile = access.profileId
      ? await this.deps.profiles.owned(access.ownerId, access.profileId)
      : undefined;
    const effective = await this.deps.profiles.access?.effective(access);
    const permissions = effective ?? profile;
    const granted = permissions
      ? rows.filter((row) => permissions!.contentIds.includes(row.id))
      : rows;
    const visible = await this.scopedCatalog(access.ownerId, granted);
    const filtered = permissions
      ? visible.filter((row) => permissions.contentIds.includes(row.id))
      : visible;
    return profile ? projectContent(filtered, profile.catalog) : filtered;
  }
  private async scopedCatalog(ownerId: string, rows: ContentEntry[]) {
    const scoped = await Promise.all(
      [...new Set(rows.map((row) => row.connectionId))].map(async (id) => {
        const catalog = await this.deps.connections.catalogForAccess(ownerId, id);
        return catalog
          ? catalogEntries(await this.deps.connections.context(ownerId, id), catalog)
          : [];
      }),
    );
    const permitted = new Set(
      await this.deps.shares.permitted(
        ownerId,
        'contentIds',
        scoped.flat().map((entry) => entry.id),
      ),
    );
    return scoped.flat().filter((entry) => permitted.has(entry.id));
  }
  definition(entry: ContentEntry) {
    const { definition, connectionId } = entry;
    if (entry.kind === 'prompt') return { ...definition, name: entry.id };
    if (entry.kind === 'template')
      return { ...definition, uriTemplate: scopedUri(connectionId, entry.locator) };
    return { ...definition, uri: scopedUri(connectionId, entry.locator) };
  }
  async eventVisible(
    access: ContentAccess,
    event: { connectionId: string; method: string; uri?: string },
  ) {
    const { connectionId, method, uri } = event;
    const profile = access.profileId
      ? await this.deps.profiles.owned(access.ownerId, access.profileId)
      : undefined;
    const effective = await this.deps.profiles.access?.effective(access);
    const permissions = effective ?? profile;
    if (method === 'notifications/tools/list_changed') {
      const rows = await this.deps.db
        .select({ id: tools.id })
        .from(tools)
        .where(
          and(
            await this.deps.shares.resourceFilter(access.ownerId, 'toolIds'),
            eq(tools.connectionId, connectionId),
          ),
        );
      return rows.some((row) => !permissions || permissions.toolIds.includes(row.id));
    }
    const rows = await this.deps.db
      .select()
      .from(mcpEntries)
      .where(
        and(
          await this.deps.shares.resourceFilter(access.ownerId, 'contentIds'),
          eq(mcpEntries.connectionId, connectionId),
        ),
      );
    const prompt = method === 'notifications/prompts/list_changed';
    return rows.some(
      (row) =>
        (!permissions || permissions.contentIds.includes(row.id)) &&
        (method === 'notifications/resources/updated'
          ? Boolean(
              uri &&
                (row.kind === 'resource'
                  ? row.locator === uri
                  : row.kind === 'template' && new UriTemplate(row.locator).match(uri)),
            )
          : prompt
            ? row.kind === 'prompt'
            : row.kind !== 'prompt'),
    );
  }
  async prompt(
    input: ContentAccess & { id: string; arguments?: Record<string, string> } & McpRequestOptions,
  ) {
    const [stored] = await this.deps.db
      .select()
      .from(mcpEntries)
      .where(
        and(
          await this.deps.shares.resourceFilter(input.ownerId, 'contentIds'),
          eq(mcpEntries.id, input.id),
        ),
      );
    if (!stored) throw new AppError('PROMPT_FORBIDDEN', '该 Prompt 不存在或未授权', 403);
    const entry = (await this.catalog(input, stored.connectionId)).find(
      (row) => row.kind === 'prompt' && row.id === input.id,
    );
    if (!entry) throw new AppError('PROMPT_FORBIDDEN', '该 Prompt 不存在或未授权', 403);
    const result = await this.execute(
      entry,
      { method: 'prompts/get', params: { name: entry.locator, arguments: input.arguments } },
      input,
    );
    await this.assertStillGranted(input, entry);
    return scopeResult(entry.connectionId, GetPromptResultSchema.parse(result));
  }
  async resolveResource(access: ContentAccess, uri: string) {
    const connection = z.uuid().safeParse(/^(?:mcp-platform|ui):\/\/([^/]+)\//.exec(uri)?.[1]);
    if (!connection.success)
      throw new AppError('RESOURCE_FORBIDDEN', '资源 URI 缺少有效连接命名空间', 403);
    const entries = await this.catalog(access, connection.data);
    for (const entry of entries) {
      if (entry.kind === 'prompt') continue;
      const original = originalUri(entry.connectionId, uri);
      if (original === undefined) continue;
      if (entry.kind === 'resource' && original === entry.locator) return { entry, original };
      if (entry.kind === 'template' && new UriTemplate(entry.locator).match(original))
        return { entry, original };
    }
    throw new AppError('RESOURCE_FORBIDDEN', '该 Resource 不存在或未授权', 403);
  }
  async read(input: ContentAccess & { uri: string } & McpRequestOptions) {
    const { entry, original } = await this.resolveResource(input, input.uri);
    const result = await this.execute(
      entry,
      { method: 'resources/read', params: { uri: original } },
      input,
    );
    await this.assertStillGranted(input, entry);
    return scopeResult(entry.connectionId, ReadResourceResultSchema.parse(result));
  }
  async execute(entry: ContentEntry, operation: McpOperation, options: McpRequestOptions) {
    const adapter = await this.adapter(entry);
    const abort = new AbortController();
    const access = {
      ownerId: entry.callerId ?? entry.ownerId,
      profileId: currentExecution()?.profileId,
    };
    const release = await this.deps.profiles.access?.monitor({
      access,
      kind: 'contentIds',
      id: entry.id,
      cancel: () => abort.abort(),
    });
    try {
      return await adapter.request(operation, {
        ...options,
        signal: AbortSignal.any([abort.signal, ...(options.signal ? [options.signal] : [])]),
      });
    } finally {
      release?.();
    }
  }
  async subscribe(entry: ContentEntry, uri: string, onRevoked?: () => void) {
    const context = await this.deps.connections.context(
      entry.callerId ?? entry.ownerId,
      entry.connectionId,
    );
    const adapter = await this.adapter(entry);
    const abort = new AbortController();
    // Cleanup belongs to this adapter lifetime and must never open a replacement connection.
    let unwatch: (() => void) | undefined = undefined;
    let releasing: Promise<void> | undefined;
    const release = () =>
      (releasing ??= (async () => {
        unwatch?.();
        unwatchClosing?.();
        await adapter.request({ method: 'resources/unsubscribe', params: { uri } });
      })());
    const unwatchClosing = this.deps.connections.watchClosing(async (closing) => {
      if (closing.runtimeKey !== context.runtimeKey) return;
      abort.abort(new Error('订阅会话已结束'));
      onRevoked?.();
      await release();
    });
    unwatch = await this.deps.profiles.access?.monitor({
      access: {
        ownerId: entry.callerId ?? entry.ownerId,
        profileId: currentExecution()?.profileId,
      },
      kind: 'contentIds',
      id: entry.id,
      cancel: () => {
        abort.abort(new Error('订阅授权已失效'));
        onRevoked?.();
        void release().catch(() =>
          this.deps.logger.report('SUBSCRIPTION_CLEANUP_FAILED', entry.callerId ?? entry.ownerId),
        );
      },
    });
    try {
      abort.signal.throwIfAborted();
      await adapter.request(
        { method: 'resources/subscribe', params: { uri } },
        { signal: abort.signal },
      );
    } catch (error) {
      unwatch?.();
      unwatchClosing?.();
      throw error;
    }
    return release;
  }
  private async adapter(entry: ContentEntry) {
    const ownerId = entry.callerId ?? entry.ownerId;
    const connection = await this.deps.connections.accessible(ownerId, entry.connectionId);
    if (connection.status === 'stopped')
      throw new AppError('CONNECTION_STOPPED', '连接已停止，请先启动', 409);
    return this.deps.connections.adapter(ownerId, entry.connectionId);
  }
  private async assertStillGranted(access: ContentAccess, entry: ContentEntry) {
    if (!(await this.catalog(access, entry.connectionId)).some((row) => row.id === entry.id))
      throw new AppError('GRANT_REVOKED', '请求期间权限已撤销', 403);
  }
}
