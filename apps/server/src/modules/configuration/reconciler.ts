import { and, eq } from 'drizzle-orm';
import {
  connectionShares,
  profiles,
  user,
  type configManifests,
  type ManifestEntryState,
  type Database,
} from '@platform/db';
import type { ConnectionService } from '../mcp/connectionService.js';
import type { ProfileService } from '../agent-profiles/profileService.js';
import type { ShareService } from '../shares/shareService.js';
import type { ConfigSecrets } from './secretService.js';
import { AppError } from '../../shared/errors.js';
import { connectionValues, DeploymentPending, external, fingerprint } from './values.js';
import { resolveProfile } from './profileResolution.js';
type Manifest = typeof configManifests.$inferSelect;
export type ReconcilerDeps = {
  db: Database;
  connections: ConnectionService;
  profiles: ProfileService;
  shares: ShareService;
  secrets: ConfigSecrets;
  directory: (path: string) => Promise<void>;
  changed: (profileId: string) => Promise<void>;
};
export class ManifestReconciler {
  constructor(private readonly deps: ReconcilerDeps) {}
  async reconcile(input: {
    manifest: Manifest;
    entry: ManifestEntryState;
    entries: readonly ManifestEntryState[];
    checkpoint: (entry: ManifestEntryState) => Promise<void>;
  }): Promise<ManifestEntryState> {
    if (input.entry.kind === 'connection') return this.connection(input);
    if (input.entry.kind === 'profile') return this.profile(input);
    return this.share(input);
  }
  private async connection(input: Parameters<ManifestReconciler['reconcile']>[0]) {
    const { manifest, entry, checkpoint } = input;
    const declaration = manifest.declaration.connections[entry.name]!;
    if ('sharedRef' in declaration) {
      const id = external(manifest.mappings, 'shares', declaration.sharedRef);
      const [share] = await this.deps.db
        .select()
        .from(connectionShares)
        .where(
          and(
            eq(connectionShares.id, id),
            eq(connectionShares.recipientId, manifest.ownerId),
            eq(connectionShares.revoked, false),
          ),
        );
      if (!share) throw new DeploymentPending(`共享授权 ${declaration.sharedRef} 不存在或已撤销`);
      const next = {
        ...entry,
        objectId: share.connectionId,
        managed: false,
        revision: share.version,
      };
      await checkpoint(next);
      await this.requireSnapshot(manifest.ownerId, share.connectionId);
      return { ...next, status: 'ready' as const, reason: undefined };
    }
    const config = await connectionValues(declaration, {
      mappings: manifest.mappings,
      secret: (name) => this.deps.secrets.read(manifest.ownerId, name),
      directory: this.deps.directory,
    });
    const desired = fingerprint(config);
    let next = entry;
    if (!entry.revision) {
      const created = await this.deps.connections.createIdentified(manifest.ownerId, {
        id: entry.objectId!,
        config,
      });
      next = { ...entry, revision: created.revision, fingerprint: desired };
    } else {
      const row = await this.deps.connections.owned(manifest.ownerId, entry.objectId!);
      if (row.revision !== entry.revision)
        throw new AppError('MANIFEST_CONFLICT', `连接 ${entry.name} 已被人工编辑`, 409);
      if (desired !== entry.fingerprint) {
        await this.deps.connections.replace(manifest.ownerId, row.id, {
          ...config,
          revision: row.revision,
        });
        next = { ...entry, revision: row.revision + 1, fingerprint: desired };
      }
    }
    await checkpoint(next);
    if (next.revision !== entry.revision)
      await this.deps.connections.discover(manifest.ownerId, next.objectId!);
    await this.requireSnapshot(manifest.ownerId, next.objectId!);
    return { ...next, status: 'ready' as const, reason: undefined };
  }
  private async requireSnapshot(ownerId: string, id: string) {
    if (await this.deps.connections.snapshot(ownerId, id)) return;
    const row = await this.deps.connections.accessible(ownerId, id);
    throw new DeploymentPending(
      `尚无真实目录（连接状态 ${row.status}）；请完成凭证、设备或目录配置后连接`,
    );
  }
  private async profile(input: Parameters<ManifestReconciler['reconcile']>[0]) {
    const { entry, manifest } = input;
    const row = await this.deps.profiles.owned(manifest.ownerId, entry.objectId!);
    if (entry.revision !== row.revision)
      throw new AppError('MANIFEST_CONFLICT', `Profile ${entry.name} 已被人工编辑`, 409);
    const value = await resolveProfile({
      ownerId: manifest.ownerId,
      declaration: manifest.declaration.profiles[entry.name]!,
      mappings: manifest.mappings,
      entries: input.entries,
      connections: this.deps.connections,
    });
    const desired = fingerprint(value);
    const saved =
      desired === entry.fingerprint
        ? row
        : (await this.deps.profiles.save(
            manifest.ownerId,
            { ...value, revision: row.revision },
            row.id,
          ))!;
    const next = { ...entry, revision: saved.revision, fingerprint: desired };
    await input.checkpoint(next);
    const ready = await this.deps.db
      .update(profiles)
      .set({ deploymentState: 'ready' })
      .where(and(eq(profiles.id, row.id), eq(profiles.revision, saved.revision)))
      .returning({ id: profiles.id });
    if (!ready.length)
      throw new AppError('MANIFEST_CONFLICT', `Profile ${entry.name} 已被人工编辑`, 409);
    if (row.deploymentState !== 'ready' || row.revision !== saved.revision)
      await this.deps.changed(row.id);
    return { ...next, status: 'ready' as const, reason: undefined };
  }
  private async share(input: Parameters<ManifestReconciler['reconcile']>[0]) {
    const { manifest, entry } = input;
    const value = manifest.declaration.shares[entry.name]!;
    const source = input.entries.find(
      (e) => e.kind === 'connection' && e.name === value.connection && e.status === 'ready',
    );
    if (!source?.objectId) throw new DeploymentPending(`共享来源 ${value.connection} 尚未就绪`);
    const recipientId = external(manifest.mappings, 'users', value.recipientRef);
    const [recipient] = await this.deps.db
      .select()
      .from(user)
      .where(and(eq(user.id, recipientId), eq(user.enabled, true)));
    if (!recipient) throw new DeploymentPending(`接收账号 ${value.recipientRef} 不存在或已停用`);
    const resolved = await resolveProfile({
      ...this.deps,
      ownerId: manifest.ownerId,
      mappings: manifest.mappings,
      entries: input.entries,
      declaration: {
        name: entry.name,
        instructions: '',
        discoveryMode: 'direct',
        resultPresentation: { enabled: false, thresholdBytes: 32768, retainBytes: 8192 },
        searchOptions: {
          strategy: 'exact',
          minScore: null,
          hnsw: { m: 16, efConstruction: 64, efSearch: 100 },
        },
        embedding: null,
        pinnedTools: [],
        tools: value.tools.map((name) => ({
          connection: value.connection,
          name,
          hiddenParameters: [],
        })),
        content: value.content.map((c) => ({ ...c, connection: value.connection })),
        artifacts: [],
        skills: [],
        requestable: { tools: [], content: [], artifacts: [] },
        toolNaming: 'stable',
        connectionAliases: {},
        connectionIdentities: {},
      },
    });
    const outgoing = await this.deps.shares.outgoing(manifest.ownerId, source.objectId);
    const existing = outgoing.find((grant) => grant.recipientId === recipientId);
    if (existing && (existing.id !== entry.objectId || existing.version !== entry.revision))
      throw new AppError('MANIFEST_CONFLICT', `共享授权 ${entry.name} 已存在或被人工编辑`, 409);
    const desired = fingerprint({
      source: source.objectId,
      recipientId,
      mode: value.credentialMode,
      tools: resolved.toolIds,
      content: resolved.contentIds,
    });
    if (entry.fingerprint === desired && existing)
      return { ...entry, status: 'ready' as const, reason: undefined };
    const grant = await this.deps.shares.save(manifest.ownerId, source.objectId, {
      recipientEmail: recipient.email,
      credentialMode: value.credentialMode,
      toolIds: resolved.toolIds,
      contentIds: resolved.contentIds,
      version: existing?.version,
    });
    return {
      ...entry,
      objectId: grant.id,
      revision: grant.version,
      fingerprint: desired,
      status: 'ready' as const,
      reason: undefined,
    };
  }
}
