import { assertDeploymentReady } from '../configuration/readiness.js';
import type { DiagnosticLogger } from '../activity/systemLogger.js';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import {
  accessKeys,
  oauthGrants,
  profiles,
  tasks,
  temporaryGrants,
  type Database,
} from '@platform/db';
import type { PermissionSet } from '@platform/contracts';
import { currentExecution, withExecution } from '../mcp/executionContext.js';
import { AppError, requireValue } from '../../shared/errors.js';
import { activeUser } from '../users/userAccess.js';
import type { ShareAccess } from '../shares/shareAccess.js';
export type Access = { ownerId: string; profileId?: string };
export type PermissionKind = keyof PermissionSet;
export const emptyPermissions = (): PermissionSet => ({
  toolIds: [],
  contentIds: [],
  artifactIds: [],
});
export const subject = () => {
  const context = currentExecution();
  if (context?.taskId) return `task:${context.taskId}`;
  return `credential:${context?.credentialId ?? context?.identity ?? 'dashboard'}`;
};
export class AccessService {
  private readonly listeners = new Set<() => Promise<void>>();
  onChanged(listener: () => Promise<void>) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private readonly monitors = new Set<() => Promise<void>>();
  constructor(
    private readonly deps: {
      db: Database;
      logger: DiagnosticLogger;
      shares: ShareAccess;
      binding: (ownerId: string, connectionId: string) => Promise<string>;
    },
  ) {}
  async profile(access: Access) {
    const [profile] = await this.deps.db
      .select()
      .from(profiles)
      .where(and(eq(profiles.id, access.profileId!), eq(profiles.ownerId, access.ownerId)));
    const current = requireValue(profile);
    assertDeploymentReady(current);
    return current;
  }
  async assertSubject(access: Access) {
    await activeUser(this.deps.db, access.ownerId);
    const context = currentExecution();
    if (context?.ownerId && context.ownerId !== access.ownerId)
      throw new AppError('ACCESS_CONTEXT', '访问上下文账号不匹配', 403);
    if (context?.profileId && context.profileId !== access.profileId)
      throw new AppError('ACCESS_CONTEXT', '访问上下文 Agent 不匹配', 403);
    if (context?.taskId) {
      const [task] = await this.deps.db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.id, context.taskId),
            eq(tasks.ownerId, access.ownerId),
            eq(tasks.profileId, access.profileId!),
          ),
        );
      if (!task || !['running', 'waiting_authorization'].includes(task.status))
        throw new AppError('TASK_ENDED', '任务已结束或中断', 403);
    }
    const credentialId = context?.credentialId;
    if (!credentialId || !['gateway', 'rest'].includes(context?.entry ?? '')) return;
    const now = new Date();
    const [key] = await this.deps.db
      .select()
      .from(accessKeys)
      .where(
        and(
          eq(accessKeys.id, credentialId),
          eq(accessKeys.ownerId, access.ownerId),
          eq(accessKeys.profileId, access.profileId!),
          eq(accessKeys.revoked, false),
          or(isNull(accessKeys.expiresAt), gt(accessKeys.expiresAt, now)),
        ),
      );
    if (key) return;
    const [grant] = await this.deps.db
      .select()
      .from(oauthGrants)
      .where(
        and(
          eq(oauthGrants.id, credentialId),
          eq(oauthGrants.ownerId, access.ownerId),
          eq(oauthGrants.profileId, access.profileId!),
          eq(oauthGrants.revoked, false),
          gt(oauthGrants.expiresAt, now),
        ),
      );
    if (!grant) throw new AppError('UNAUTHORIZED', '调用凭证已失效', 401);
  }
  binding(ownerId: string, connectionId: string) {
    return this.deps.binding(ownerId, connectionId);
  }
  async bindingsValid(bindings: Record<string, string>) {
    const ownerId = currentExecution()?.ownerId;
    if (!ownerId) return false;
    for (const [id, expected] of Object.entries(bindings)) {
      try {
        if ((await this.deps.binding(ownerId, id)) !== expected) return false;
      } catch (error) {
        if (error instanceof AppError && ['BINDING_REVOKED', 'NOT_FOUND'].includes(error.code))
          return false;
        throw error;
      }
    }
    return true;
  }
  async effective(access: Access): Promise<PermissionSet | undefined> {
    await this.assertSubject(access);
    if (!access.profileId) return undefined;
    const profile = await this.profile(access);
    const result: PermissionSet = {
      toolIds: [...profile.toolIds],
      contentIds: [...profile.contentIds],
      artifactIds: [...profile.artifactIds],
    };
    const grants = await this.deps.db
      .select()
      .from(temporaryGrants)
      .where(
        and(
          eq(temporaryGrants.ownerId, access.ownerId),
          eq(temporaryGrants.profileId, profile.id),
          eq(temporaryGrants.subject, subject()),
          eq(temporaryGrants.profileRevision, profile.revision),
          isNull(temporaryGrants.revokedAt),
          gt(temporaryGrants.expiresAt, new Date()),
        ),
      );
    for (const grant of grants) {
      if (!(await this.bindingsValid(grant.bindings))) continue;
      for (const kind of Object.keys(result) as PermissionKind[])
        result[kind] = [...new Set([...result[kind], ...grant.permissions[kind]])];
    }
    return {
      ...result,
      toolIds: await this.deps.shares.permitted(access.ownerId, 'toolIds', result.toolIds),
      contentIds: await this.deps.shares.permitted(access.ownerId, 'contentIds', result.contentIds),
    };
  }
  async allows(access: Access, kind: PermissionKind, id: string) {
    const permissions = await this.effective(access);
    if (permissions && !permissions[kind].includes(id)) return false;
    return (await this.deps.shares.permitted(access.ownerId, kind, [id])).includes(id);
  }
  async assert(access: Access, kind: PermissionKind, id: string) {
    if (!(await this.allows(access, kind, id)))
      throw new AppError('GRANT_REVOKED', '当前 Agent 未获此项权限或授权已失效', 403);
  }
  async monitor(input: { access: Access; kind: PermissionKind; id: string; cancel: () => void }) {
    const context = currentExecution();
    let timer: NodeJS.Timeout | undefined;
    let released = false;
    const release = () => {
      released = true;
      clearTimeout(timer);
      this.monitors.delete(check);
    };
    const schedule = async () => {
      clearTimeout(timer);
      const deadlines = await this.deps.db
        .select({ at: temporaryGrants.expiresAt })
        .from(temporaryGrants)
        .where(
          and(
            eq(temporaryGrants.ownerId, input.access.ownerId),
            gt(temporaryGrants.expiresAt, new Date()),
          ),
        );
      if (context?.credentialId) {
        const [key] = await this.deps.db
          .select({ at: accessKeys.expiresAt })
          .from(accessKeys)
          .where(eq(accessKeys.id, context.credentialId));
        const [grant] = await this.deps.db
          .select({ at: oauthGrants.expiresAt })
          .from(oauthGrants)
          .where(eq(oauthGrants.id, context.credentialId));
        if (key?.at && key.at.getTime() > Date.now()) deadlines.push({ at: key.at });
        if (grant?.at && grant.at.getTime() > Date.now()) deadlines.push(grant);
      }
      const next = deadlines.map((d) => d.at.getTime()).sort((a, b) => a - b)[0];
      if (!next || released) return;
      timer = setTimeout(
        () => {
          void check().catch(() =>
            this.deps.logger.report('PERMISSION_EXPIRY_FAILED', input.access.ownerId),
          );
        },
        Math.min(Math.max(1, next - Date.now() + 1), 2_147_483_647),
      );
      timer.unref();
    };
    const check = async () => {
      if (released) return;
      try {
        const action = () => this.assert(input.access, input.kind, input.id);
        await (context ? withExecution(context, action) : action());
        await schedule();
      } catch (error) {
        release();
        input.cancel();
        if (!(error instanceof AppError)) throw error;
      }
    };
    await check();
    if (!released) this.monitors.add(check);
    return release;
  }
  async changed() {
    await Promise.all([...this.listeners].map((listener) => listener()));
    await Promise.all([...this.monitors].map((check) => check()));
  }
}
