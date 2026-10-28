import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt } from 'drizzle-orm';
import {
  account,
  accessKeys,
  oauthCodes,
  oauthGrants,
  session,
  user,
  type Database,
} from '@platform/db';
import { z } from 'zod';
import { AppError, requireValue } from '../../shared/errors.js';
import { activeUser, adminUser } from './userAccess.js';

const editable = z
  .object({
    name: z.string().trim().min(1),
    email: z.email().transform((value) => value.toLowerCase()),
    role: z.enum(['admin', 'member']),
    enabled: z.boolean(),
  })
  .strict();
const newUser = editable.extend({ password: z.string().min(8).max(128) });

export class UserService {
  constructor(
    private readonly deps: {
      db: Database;
      hashPassword: (password: string) => Promise<string>;
      disabled: (ownerId: string) => Promise<void>;
    },
  ) {}

  async list(actorId: string) {
    await adminUser(this.deps.db, actorId);
    return this.deps.db.select().from(user).orderBy(desc(user.createdAt), user.id);
  }

  async create(actorId: string, input: unknown) {
    await adminUser(this.deps.db, actorId);
    const { password, ...value } = newUser.parse(input);
    const hash = await this.deps.hashPassword(password);
    const id = randomUUID();
    return this.uniqueEmail(() =>
      this.deps.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(user)
          .values({ ...value, id })
          .returning();
        await tx.insert(account).values({
          id: randomUUID(),
          userId: id,
          accountId: id,
          providerId: 'credential',
          password: hash,
        });
        return requireValue(created);
      }),
    );
  }

  async update(actorId: string, id: string, input: unknown) {
    await adminUser(this.deps.db, actorId);
    const value = editable
      .partial()
      .refine((data) => Object.keys(data).length > 0)
      .parse(input);
    const updated = await this.uniqueEmail(() =>
      this.deps.db.transaction(async (tx) => {
        const [previous] = await tx.select().from(user).where(eq(user.id, id)).for('update');
        requireValue(previous);
        const [row] = await tx
          .update(user)
          .set({
            ...value,
            ...(value.email && value.email !== previous!.email ? { emailVerified: false } : {}),
          })
          .where(eq(user.id, id))
          .returning();
        if (value.enabled === false) {
          await tx.delete(session).where(eq(session.userId, id));
          await tx.delete(oauthCodes).where(eq(oauthCodes.ownerId, id));
          await tx.update(accessKeys).set({ revoked: true }).where(eq(accessKeys.ownerId, id));
          await tx.update(oauthGrants).set({ revoked: true }).where(eq(oauthGrants.ownerId, id));
        }
        return requireValue(row);
      }),
    );
    // Persist denial before runtime cleanup so a failed cleanup cannot restore access.
    if (!updated.enabled) await this.deps.disabled(id);
    return updated;
  }

  async sessions(actorId: string, targetId = actorId) {
    if (targetId !== actorId) await adminUser(this.deps.db, actorId);
    else await activeUser(this.deps.db, actorId);
    return this.deps.db
      .select({
        id: session.id,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      })
      .from(session)
      .where(and(eq(session.userId, targetId), gt(session.expiresAt, new Date())));
  }

  async revokeSessions(input: { actorId: string; targetId: string; sessionId?: string }) {
    if (input.targetId !== input.actorId) await adminUser(this.deps.db, input.actorId);
    else await activeUser(this.deps.db, input.actorId);
    await this.deps.db
      .delete(session)
      .where(
        and(
          eq(session.userId, input.targetId),
          input.sessionId ? eq(session.id, input.sessionId) : undefined,
        ),
      );
  }

  private async uniqueEmail<T>(action: () => Promise<T>) {
    try {
      return await action();
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === '23505')
        throw new AppError('ACCOUNT_EXISTS', '邮箱或身份已被使用', 409);
      throw error;
    }
  }
}
