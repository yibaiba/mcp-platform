import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { profiles, temporaryGrants, type Database } from '@platform/db';
import { AppError } from '../../shared/errors.js';
import { currentExecution } from '../mcp/executionContext.js';
import { emptyPermissions, subject, type AccessService } from './accessService.js';
import { DEFAULT_LIFETIME_MS } from './requestPolicy.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type OutputScope = {
  ownerId: string;
  profileId: string;
  profileRevision: number;
  subject: string;
  taskId?: string;
  bindings: Record<string, string>;
};

export async function captureOutputScope(
  access: AccessService,
  input: { ownerId: string; connectionId: string },
): Promise<OutputScope | undefined> {
  const context = currentExecution();
  if (!context?.profileId) return;
  const caller = { ownerId: input.ownerId, profileId: context.profileId };
  await access.assertSubject(caller);
  const profile = await access.profile(caller);
  return {
    ...caller,
    profileRevision: profile.revision,
    subject: subject(),
    taskId: context.taskId,
    bindings: { [input.connectionId]: await access.binding(input.ownerId, input.connectionId) },
  };
}

export async function grantOutput(
  deps: { tx: Transaction; access: AccessService },
  input: { scope: OutputScope; artifactId: string },
) {
  const { scope } = input;
  const [profile] = await deps.tx
    .select()
    .from(profiles)
    .where(and(eq(profiles.id, scope.profileId), eq(profiles.ownerId, scope.ownerId)))
    .for('update');
  if (!profile || profile.revision !== scope.profileRevision)
    throw new AppError('OUTPUT_SCOPE_CHANGED', '产物生成期间 Agent 配置已变化', 409);
  await deps.access.assertSubject(scope);
  if (subject() !== scope.subject || !(await deps.access.bindingsValid(scope.bindings)))
    throw new AppError('OUTPUT_SCOPE_CHANGED', '产物生成期间调用主体或上游身份已变化', 409);
  // A result belongs to its producing credential/task, never to every key on the Profile.
  await deps.tx.insert(temporaryGrants).values({
    id: randomUUID(),
    ...scope,
    permissions: { ...emptyPermissions(), artifactIds: [input.artifactId] },
    expiresAt: new Date(Date.now() + DEFAULT_LIFETIME_MS),
  });
}
