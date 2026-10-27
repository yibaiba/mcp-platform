import { z } from 'zod';
import type { PermissionSet } from '@platform/contracts';
import { permissionSet } from '@platform/contracts';
import type { permissionRequests } from '@platform/db';
import type { PermissionKind } from './accessService.js';
import { PLATFORM_CAPABILITIES } from '../mcp/executionContext.js';
import { AppError } from '../../shared/errors.js';
const kinds: PermissionKind[] = ['toolIds', 'contentIds', 'artifactIds'];
export const decisionInput = z
  .object({
    decision: z.enum(['approved', 'rejected', 'cancelled']),
    permissions: permissionSet.optional(),
    expiresAt: z.iso.datetime().optional(),
  })
  .strict();
export const DEFAULT_LIFETIME_MS = 60 * 60_000;
export function requestContext(row: typeof permissionRequests.$inferSelect) {
  const task = Boolean(row.taskId);
  const identity = task ? `pi:${row.profileId}` : row.subject.slice('credential:'.length);
  return {
    ownerId: row.ownerId,
    profileId: row.profileId,
    taskId: row.taskId ?? undefined,
    credentialId: task ? undefined : identity,
    identity,
    entry: task ? ('pi' as const) : ('gateway' as const),
    sessionId: row.taskId ?? 'approval',
    capabilities: PLATFORM_CAPABILITIES,
  };
}
export function subset(selected: PermissionSet, allowed: PermissionSet) {
  if (kinds.some((kind) => selected[kind].some((id) => !allowed[kind].includes(id))))
    throw new AppError('PERMISSION_SUBSET', '只能选择预先开放或申请范围内的权限', 403);
}
