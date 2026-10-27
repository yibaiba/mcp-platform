import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  permissionRequests,
  temporaryGrants,
  workspaceEvents,
  profiles,
  type Database,
} from '@platform/db';
import { AppError, requireValue } from '../../shared/errors.js';
import { withExecution } from '../mcp/executionContext.js';
import type { AccessService } from './accessService.js';
import { subset, requestContext, decisionInput, DEFAULT_LIFETIME_MS } from './requestPolicy.js';
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export async function approveRequest(
  deps: { db: Database; access: AccessService },
  input: { ownerId: string; id: string; input: unknown },
) {
  const { ownerId, id } = input;
  const decision = decisionInput.parse(input.input);
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(permissionRequests)
      .where(and(eq(permissionRequests.id, id), eq(permissionRequests.ownerId, ownerId)))
      .for('update');
    const request = requireValue(row);
    if (request.status !== 'pending') return request;
    const profile = await validateRequest({ tx, access: deps.access, request });
    const approved = decision.permissions ?? { toolIds: [], contentIds: [], artifactIds: [] };
    subset(approved, request.requested);
    const expiresAt = new Date(decision.expiresAt ?? Date.now() + DEFAULT_LIFETIME_MS);
    if (expiresAt.getTime() <= Date.now())
      throw new AppError('GRANT_EXPIRED', '授权到期时间必须在未来');
    if (decision.decision === 'approved')
      await tx.insert(temporaryGrants).values({
        id: randomUUID(),
        ownerId,
        profileId: profile.id,
        subject: request.subject,
        taskId: request.taskId,
        requestId: id,
        profileRevision: profile.revision,
        bindings: request.bindings,
        permissions: approved,
        expiresAt,
      });
    const [updated] = await tx
      .update(permissionRequests)
      .set({
        status: decision.decision,
        approved,
        expiresAt: decision.decision === 'approved' ? expiresAt : null,
        decidedAt: new Date(),
      })
      .where(eq(permissionRequests.id, id))
      .returning();
    await tx.insert(workspaceEvents).values({
      id: randomUUID(),
      ownerId,
      aggregateId: id,
      kind: 'permission',
      revision: 1,
      data: { status: decision.decision, approved, expiresAt: expiresAt.toISOString() },
    });
    return requireValue(updated);
  });
}

async function validateRequest({
  tx,
  access,
  request,
}: {
  tx: Transaction;
  access: AccessService;
  request: typeof permissionRequests.$inferSelect;
}) {
  const [profile] = await tx
    .select()
    .from(profiles)
    .where(eq(profiles.id, request.profileId))
    .for('update');
  if (!profile || profile.revision !== request.profileRevision)
    throw new AppError('REQUEST_INVALIDATED', '申请时的 Agent 配置已变化', 409);
  if (request.deadline && request.deadline.getTime() <= Date.now())
    throw new AppError('REQUEST_EXPIRED', '申请已过截止时间', 409);
  subset(request.requested, profile.requestable);
  await withExecution(requestContext(request), async () => {
    await access.assertSubject({ ownerId: request.ownerId, profileId: profile.id });
    if (!(await access.bindingsValid(request.bindings)))
      throw new AppError('REQUEST_INVALIDATED', '上游身份已变化', 409);
  });
  return requireValue(profile);
}
