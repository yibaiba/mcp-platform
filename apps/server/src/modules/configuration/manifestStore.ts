import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  configManifests,
  connections,
  profiles,
  connectionShares,
  type Database,
  type ManifestEntryState,
} from '@platform/db';
import type { ManifestApply } from '@platform/contracts';
import { AppError, requireValue } from '../../shared/errors.js';
import { fingerprint } from './values.js';
export type StoredManifest = typeof configManifests.$inferSelect;
export const entryKey = (entry: Pick<ManifestEntryState, 'kind' | 'name'>) =>
  `${entry.kind}:${entry.name}`;
export function declaredEntries(input: ManifestApply): ManifestEntryState[] {
  return (['connection', 'profile', 'share'] as const).flatMap((kind) =>
    Object.keys(input.declaration[`${kind}s`]).map((name) => ({
      kind,
      name,
      managed: kind !== 'connection' || !('sharedRef' in input.declaration.connections[name]!),
      objectId: kind === 'share' ? undefined : randomUUID(),
      status: 'pending' as const,
    })),
  );
}
export class ManifestStore {
  constructor(readonly db: Database) {}
  list(ownerId: string) {
    return this.db.select().from(configManifests).where(eq(configManifests.ownerId, ownerId));
  }
  async find(ownerId: string, name: string) {
    const [row] = await this.db
      .select()
      .from(configManifests)
      .where(and(eq(configManifests.ownerId, ownerId), eq(configManifests.name, name)));
    return row;
  }
  async conflicts(ownerId: string, entries: readonly ManifestEntryState[]) {
    const conflicts: string[] = [];
    for (const entry of entries) {
      if (!entry.managed || !entry.objectId || entry.revision === undefined) continue;
      const table =
        entry.kind === 'connection'
          ? connections
          : entry.kind === 'profile'
            ? profiles
            : connectionShares;
      const revision =
        entry.kind === 'share'
          ? connectionShares.version
          : entry.kind === 'connection'
            ? connections.revision
            : profiles.revision;
      const [row] = await this.db
        .select({ revision })
        .from(table)
        .where(and(eq(table.id, entry.objectId), eq(table.ownerId, ownerId)));
      if (row?.revision !== entry.revision) conflicts.push(entryKey(entry));
    }
    return conflicts;
  }
  async accept(ownerId: string, input: ManifestApply) {
    const previous = await this.find(ownerId, input.declaration.name);
    if (input.revision !== undefined && previous?.revision !== input.revision)
      throw new AppError('REVISION_CONFLICT', 'Manifest 版本已改变', 409);
    const conflicts = await this.conflicts(ownerId, previous?.entries ?? []);
    if (conflicts.length)
      throw new AppError('MANIFEST_CONFLICT', `检测到人工编辑：${conflicts.join(', ')}`, 409);
    if (
      previous &&
      fingerprint({
        declaration: previous.declaration,
        mappings: previous.mappings,
        mode: previous.mode,
      }) ===
        fingerprint({ declaration: input.declaration, mappings: input.mappings, mode: input.mode })
    )
      return previous;
    const entries = declaredEntries(input).map((entry) => {
      const old = previous?.entries.find((old) => entryKey(old) === entryKey(entry));
      if (old && old.managed !== entry.managed)
        throw new AppError(
          'MANIFEST_CONFLICT',
          `${entryKey(entry)} 改变了资源归属；请使用新的逻辑名称`,
          409,
        );
      return old ? { ...old, status: 'pending' as const, reason: undefined } : entry;
    });
    const keys = new Set(entries.map(entryKey));
    const removed = (previous?.entries ?? []).filter((entry) => !keys.has(entryKey(entry)));
    return this.db.transaction(async (tx) => {
      for (const entry of entries.filter((entry) => entry.kind === 'profile')) {
        if (entry.revision !== undefined) {
          const changed = await tx
            .update(profiles)
            .set({ deploymentState: 'pending' })
            .where(
              and(
                eq(profiles.id, entry.objectId!),
                eq(profiles.ownerId, ownerId),
                eq(profiles.revision, entry.revision),
              ),
            )
            .returning({ id: profiles.id });
          if (!changed.length)
            throw new AppError('MANIFEST_CONFLICT', `${entryKey(entry)} 已被人工编辑`, 409);
        } else {
          await tx.insert(profiles).values({
            id: entry.objectId!,
            ownerId,
            name: input.declaration.profiles[entry.name]!.name,
            deploymentState: 'pending',
          });
          entry.revision = 1;
        }
      }
      const value = {
        declaration: input.declaration,
        mappings: input.mappings,
        mode: input.mode,
        entries: [...entries, ...removed],
        status: 'pending' as const,
        updatedAt: new Date(),
      };
      const rows = previous
        ? await tx
            .update(configManifests)
            .set({ ...value, revision: previous.revision + 1 })
            .where(
              and(
                eq(configManifests.id, previous.id),
                eq(configManifests.revision, previous.revision),
              ),
            )
            .returning()
        : await tx
            .insert(configManifests)
            .values({ ...value, ownerId, name: input.declaration.name })
            .returning();
      if (!rows.length) throw new AppError('REVISION_CONFLICT', 'Manifest 版本已改变', 409);
      return requireValue(rows[0]);
    });
  }
  async checkpoint(
    manifest: StoredManifest,
    entries: readonly ManifestEntryState[],
    db: Pick<Database, 'update'> = this.db,
  ) {
    const current = entries.filter((entry) =>
      Object.hasOwn(manifest.declaration[`${entry.kind}s`], entry.name),
    );
    const status = current.some((entry) => entry.status === 'error')
      ? 'error'
      : current.some((entry) => entry.status === 'pending') ||
          (manifest.mode === 'prune' &&
            entries.some(
              (entry) =>
                entry.managed && !Object.hasOwn(manifest.declaration[`${entry.kind}s`], entry.name),
            ))
        ? 'pending'
        : 'ready';
    if (status === manifest.status && fingerprint(entries) === fingerprint(manifest.entries))
      return manifest;
    const saved = await db
      .update(configManifests)
      .set({ entries: [...entries], status, updatedAt: new Date() })
      .where(
        and(eq(configManifests.id, manifest.id), eq(configManifests.revision, manifest.revision)),
      )
      .returning();
    if (!saved.length)
      throw new AppError('REVISION_CONFLICT', 'Manifest 版本已改变，旧解析已终止', 409);
    return requireValue(saved[0]);
  }
}
