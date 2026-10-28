import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { calls, interactions, restCalls, type Database } from '@platform/db';
import type { Principal } from '../agent-profiles/profileService.js';
import { digest, type Vault } from '../../shared/crypto.js';
import { AppError, requireValue } from '../../shared/errors.js';
import type { PendingResult } from '../interactions/interactionService.js';
export type RestCall = typeof restCalls.$inferSelect;
export class RestCallStore {
  constructor(
    private readonly db: Database,
    private readonly vault: Vault,
  ) {}
  async reserve(
    principal: Principal,
    input: { toolId: string; requestHash: string; idempotencyKey?: string },
  ) {
    const identity = {
      ownerId: principal.ownerId,
      profileId: principal.profileId,
      credentialId: principal.credentialId,
    };
    const idempotencyHash =
      input.idempotencyKey === undefined ? null : digest(input.idempotencyKey);
    const [created] = await this.db
      .insert(restCalls)
      .values({
        ...identity,
        id: randomUUID(),
        toolId: input.toolId,
        requestHash: input.requestHash,
        idempotencyHash,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return { row: created, created: true };
    const [existing] = await this.db
      .select()
      .from(restCalls)
      .where(
        and(
          eq(restCalls.ownerId, identity.ownerId),
          eq(restCalls.profileId, identity.profileId),
          eq(restCalls.credentialId, identity.credentialId),
          eq(restCalls.idempotencyHash, idempotencyHash!),
        ),
      );
    const row = requireValue(existing);
    if (row.requestHash !== input.requestHash)
      throw new AppError('IDEMPOTENCY_CONFLICT', '同一 Idempotency-Key 已用于不同请求', 409);
    return { row, created: false };
  }
  async owned(principal: Principal, id: string) {
    const [row] = await this.db
      .select()
      .from(restCalls)
      .where(
        and(
          eq(restCalls.id, id),
          eq(restCalls.ownerId, principal.ownerId),
          eq(restCalls.profileId, principal.profileId),
          eq(restCalls.credentialId, principal.credentialId),
        ),
      );
    return requireValue(row);
  }
  async update(
    id: string,
    value: Partial<
      Pick<RestCall, 'status' | 'interactionId' | 'resultDigest' | 'errorCode' | 'endedAt'>
    >,
  ) {
    await this.db.update(restCalls).set(value).where(eq(restCalls.id, id));
  }
  async claimAnswer(row: RestCall, interactionId: string) {
    const updated = await this.db
      .update(restCalls)
      .set({ status: 'running' })
      .where(
        and(
          eq(restCalls.id, row.id),
          eq(restCalls.status, 'waiting'),
          eq(restCalls.interactionId, interactionId),
        ),
      )
      .returning({ id: restCalls.id });
    if (!updated.length)
      throw new AppError('INTERACTION_DUPLICATE', '交互已提交、已结束或交互 ID 不匹配', 409);
  }
  async interaction(row: RestCall) {
    const [entry] = await this.db
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.id, row.interactionId!),
          eq(interactions.callId, row.id),
          eq(interactions.ownerId, row.ownerId),
        ),
      );
    if (!entry || entry.status !== 'waiting')
      throw new AppError('INTERACTION_INTERRUPTED', '原交互已中断或结束，不能重放', 409);
    const required = this.vault.open<PendingResult>(
      entry.encrypted,
      `interaction:${row.ownerId}:${entry.id}`,
    );
    return { interactionId: entry.id, inputRequests: required.inputRequests };
  }
  async synchronize(row: RestCall) {
    if (!['waiting', 'running'].includes(row.status)) return row;
    const [call] = await this.db
      .select({ status: calls.status })
      .from(calls)
      .where(eq(calls.id, row.id));
    if (call?.status !== 'unknown') return row;
    await this.update(row.id, {
      status: 'unknown',
      errorCode: 'RESULT_UNKNOWN',
      endedAt: new Date(),
    });
    return { ...row, status: 'unknown' as const, errorCode: 'RESULT_UNKNOWN' };
  }
  async recover() {
    await this.db
      .update(restCalls)
      .set({ status: 'unknown', errorCode: 'RESTART_INTERRUPTED', endedAt: new Date() })
      .where(inArray(restCalls.status, ['running', 'waiting']));
  }
}
