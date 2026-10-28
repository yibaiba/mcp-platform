import type { DiagnosticLogger } from '../activity/systemLogger.js';
import { approveRequest } from './requestApproval.js';
import { subset, requestContext } from './requestPolicy.js';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  permissionRequests,
  temporaryGrants,
  profiles,
  tasks,
  tools,
  mcpEntries,
  type Database,
} from '@platform/db';
import { permissionSet, type PermissionSet } from '@platform/contracts';
import { z } from 'zod';
import { AppError, requireValue } from '../../shared/errors.js';
import { currentExecution, withExecution } from '../mcp/executionContext.js';
import { AccessService, subject, type Access, type PermissionKind } from './accessService.js';
import type { ShareAccess } from '../shares/shareAccess.js';
const kinds: PermissionKind[] = ['toolIds', 'contentIds', 'artifactIds'];
const requestInput = z
  .object({
    permissions: permissionSet,
    reason: z.string().trim().min(1),
    idempotencyKey: z.string().min(1),
    deadline: z.iso.datetime().optional(),
  })
  .strict();
export class RequestService {
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly deps: {
      db: Database;
      logger: DiagnosticLogger;
      shares: ShareAccess;
      access: AccessService;
      changed: (profileId: string) => Promise<void>;
      catalog: (access: Access) => Promise<unknown>;
    },
  ) {
    deps.access.onChanged(async () => {
      for (const row of await deps.db.select({ id: profiles.id }).from(profiles))
        await this.reconcile(row.id);
    });
  }
  async catalog(access: Access) {
    await this.deps.access.assertSubject(access);
    await this.deps.access.profile(access);
    return this.deps.catalog(access);
  }
  async enabled(access: Access) {
    await this.deps.access.assertSubject(access);
    const profile = await this.deps.access.profile(access);
    return Object.values(profile.requestable).some((ids) => ids.length > 0);
  }
  async bindingMap(access: Access, permissions: PermissionSet) {
    const toolRows = permissions.toolIds.length
      ? await this.deps.db
          .select()
          .from(tools)
          .where(
            and(
              await this.deps.shares.resourceFilter(access.ownerId, 'toolIds'),
              inArray(tools.id, permissions.toolIds),
            ),
          )
      : [];
    const contentRows = permissions.contentIds.length
      ? await this.deps.db
          .select()
          .from(mcpEntries)
          .where(
            and(
              await this.deps.shares.resourceFilter(access.ownerId, 'contentIds'),
              inArray(mcpEntries.id, permissions.contentIds),
            ),
          )
      : [];
    const ids = [...new Set([...toolRows, ...contentRows].map((r) => r.connectionId))];
    return Object.fromEntries(
      await Promise.all(
        ids.map(async (id) => [id, await this.deps.access.binding(access.ownerId, id)]),
      ),
    );
  }
  async create(access: Access, input: unknown) {
    const context = currentExecution();
    if (!context || !['gateway', 'pi'].includes(context.entry))
      throw new AppError('REQUEST_SUBJECT', '权限申请需要当前调用凭证或任务', 403);
    await this.deps.access.assertSubject(access);
    const value = requestInput.parse(input);
    const profile = await this.deps.access.profile(access);
    subset(value.permissions, profile.requestable);
    const deadline = value.deadline ? new Date(value.deadline) : null;
    if (deadline && deadline.getTime() <= Date.now())
      throw new AppError('REQUEST_EXPIRED', '申请截止时间已过');
    const bindings = await this.bindingMap(access, value.permissions);
    const row = await this.deps.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(profiles)
        .where(eq(profiles.id, profile.id))
        .for('update');
      if (locked?.revision !== profile.revision)
        throw new AppError('REVISION_CONFLICT', '配置已变化，请重新申请', 409);
      await tx
        .insert(permissionRequests)
        .values({
          id: randomUUID(),
          ownerId: access.ownerId,
          profileId: profile.id,
          subject: subject(),
          taskId: context.taskId,
          profileRevision: profile.revision,
          requested: value.permissions,
          reason: value.reason,
          idempotencyKey: value.idempotencyKey,
          deadline,
          bindings,
          status: 'pending',
        })
        .onConflictDoNothing();
      const [request] = await tx
        .select()
        .from(permissionRequests)
        .where(
          and(
            eq(permissionRequests.profileId, profile.id),
            eq(permissionRequests.subject, subject()),
            eq(permissionRequests.idempotencyKey, value.idempotencyKey),
          ),
        );
      if (
        kinds.some(
          (kind) =>
            JSON.stringify(request?.requested[kind]) !== JSON.stringify(value.permissions[kind]),
        ) ||
        request?.reason !== value.reason
      )
        throw new AppError('IDEMPOTENCY_CONFLICT', '幂等键已用于其他申请', 409);
      return requireValue(request);
    });
    this.signal();
    return row;
  }
  async owned(ownerId: string, id: string) {
    const [row] = await this.deps.db
      .select()
      .from(permissionRequests)
      .where(and(eq(permissionRequests.id, id), eq(permissionRequests.ownerId, ownerId)));
    return requireValue(row);
  }
  async status(access: Access, id: string) {
    await this.deps.access.assertSubject(access);
    const row = await this.owned(access.ownerId, id);
    if (row.subject !== subject() || row.profileId !== access.profileId)
      throw new AppError('FORBIDDEN', '申请不属于当前主体', 403);
    await this.reconcile(row.profileId);
    return this.owned(access.ownerId, id);
  }
  async list(ownerId: string) {
    const rows = await this.deps.db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.ownerId, ownerId));
    await Promise.all(rows.map((row) => this.reconcile(row.id)));
    return this.deps.db
      .select()
      .from(permissionRequests)
      .where(eq(permissionRequests.ownerId, ownerId));
  }
  grants(ownerId: string) {
    return this.deps.db.select().from(temporaryGrants).where(eq(temporaryGrants.ownerId, ownerId));
  }
  async decide(ownerId: string, id: string, input: unknown) {
    const result = await approveRequest(this.deps, { ownerId, id, input });
    this.signal();
    if (result.expiresAt) this.schedule(result.profileId, result.expiresAt);
    await this.deps.access.changed();
    await this.deps.changed(result.profileId);
    return result;
  }
  async revoke(ownerId: string, id: string) {
    const [row] = await this.deps.db
      .update(temporaryGrants)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(temporaryGrants.id, id),
          eq(temporaryGrants.ownerId, ownerId),
          isNull(temporaryGrants.revokedAt),
        ),
      )
      .returning();
    if (row) {
      await this.deps.access.changed();
      await this.deps.changed(row.profileId);
    }
    return { revoked: true };
  }
  async wait(access: Access, id: string, signal: AbortSignal) {
    while (true) {
      signal.throwIfAborted();
      let wake!: () => void;
      const update = new Promise<void>((resolve) => {
        wake = resolve;
      });
      this.listeners.add(wake);
      let timer: NodeJS.Timeout | undefined;
      try {
        const row = await this.status(access, id);
        if (row.status !== 'pending') return row;
        if (row.deadline)
          timer = setTimeout(wake, Math.max(0, row.deadline.getTime() - Date.now()));
        signal.addEventListener('abort', wake, { once: true });
        if (signal.aborted) wake();
        await update;
      } finally {
        clearTimeout(timer);
        this.listeners.delete(wake);
        signal.removeEventListener('abort', wake);
      }
    }
  }
  async reconcile(profileId: string) {
    const rows = await this.deps.db
      .select()
      .from(permissionRequests)
      .where(
        and(eq(permissionRequests.profileId, profileId), eq(permissionRequests.status, 'pending')),
      );
    for (const row of rows) {
      let status = row.deadline && row.deadline.getTime() <= Date.now() ? 'expired' : '';
      const [profile] = await this.deps.db
        .select()
        .from(profiles)
        .where(eq(profiles.id, profileId));
      if (profile?.revision !== row.profileRevision) status = 'invalidated';
      try {
        await withExecution(requestContext(row), async () => {
          await this.deps.access.assertSubject({ ownerId: row.ownerId, profileId });
          if (!(await this.deps.access.bindingsValid(row.bindings)))
            throw new AppError('REQUEST_INVALIDATED', '上游身份已改变', 409);
        });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        status = 'invalidated';
      }
      if (!status) continue;
      await this.deps.db
        .update(permissionRequests)
        .set({ status })
        .where(and(eq(permissionRequests.id, row.id), eq(permissionRequests.status, 'pending')));
      this.signal();
    }
  }
  private signal() {
    for (const listener of this.listeners) listener();
  }
  private schedule(profileId: string, at: Date) {
    const timer = setTimeout(
      () => {
        if (at.getTime() > Date.now()) {
          this.schedule(profileId, at);
          return;
        }
        void this.deps.access
          .changed()
          .then(() => this.deps.changed(profileId))
          .catch(() => this.deps.logger.report('GRANT_EXPIRY_FAILED'));
      },
      Math.min(Math.max(1, at.getTime() - Date.now()), 2_147_483_647),
    );
    timer.unref();
  }
  async recover() {
    for (const grant of await this.deps.db
      .select()
      .from(temporaryGrants)
      .where(isNull(temporaryGrants.revokedAt)))
      if (grant.expiresAt.getTime() > Date.now()) this.schedule(grant.profileId, grant.expiresAt);
    await this.deps.db
      .update(permissionRequests)
      .set({ status: 'interrupted' })
      .where(
        and(
          eq(permissionRequests.status, 'pending'),
          inArray(
            permissionRequests.taskId,
            this.deps.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.status, 'unknown')),
          ),
        ),
      );
    for (const row of await this.deps.db.select({ id: profiles.id }).from(profiles))
      await this.reconcile(row.id);
  }
}
