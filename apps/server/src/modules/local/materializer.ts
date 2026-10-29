import { connections } from '@platform/db';
import { AppError } from '../../shared/errors.js';
import { eq } from 'drizzle-orm';
import type { LocalResource } from '@platform/contracts';
import type { ConnectionService } from '../mcp/connectionService.js';
import type { SkillService } from '../skills/skillService.js';
import { LocalRepository, type Binding } from './repository.js';

export class LocalMaterializer {
  constructor(
    private readonly deps: {
      repository: LocalRepository;
      connections: ConnectionService;
      skills: SkillService;
      changed: () => Promise<void>;
    },
  ) {}
  async publish(row: Binding, resource: LocalResource) {
    if (resource.kind === 'skill') {
      const version = await this.deps.skills.import(row.ownerId, {
        package: { name: resource.name, files: resource.content, dependencies: [] },
        source: `device:${row.deviceId}:${resource.id}`,
      });
      return { skillVersionId: version!.id };
    }
    const config = {
      name: resource.name,
      adapter: 'device',
      deviceId: row.deviceId,
      deviceResourceId: resource.id,
      deviceResourceDigest: resource.digest,
      mode: 'existing',
      transport: 'http',
    };
    const connectionId = row.connectionId ?? row.id;
    const connection = await this.deps.connections.createIdentified(row.ownerId, {
      id: connectionId,
      config,
    });
    const context = await this.deps.connections.context(row.ownerId, connectionId);
    if (row.connectionId && context.config.deviceResourceDigest !== resource.digest) {
      if (connection.revision !== row.connectionRevision)
        throw new AppError('SYNC_CONNECTION_CONFLICT', '平台连接配置同时改变，请处理冲突', 409);
      await this.deps.connections.update(row.ownerId, connectionId, {
        revision: connection.revision,
        deviceResourceDigest: resource.digest,
      });
    }
    const revision = (await this.deps.connections.owned(row.ownerId, connectionId)).revision;
    await this.deps.changed();
    return { connectionId, connectionRevision: revision };
  }
  async invalidate(row: Binding) {
    if (!row.connectionId) return;
    await this.deps.connections.close(row.ownerId, row.connectionId);
    await this.deps.repository.db
      .update(connections)
      .set({ status: 'stopped' })
      .where(eq(connections.id, row.connectionId));
    await this.deps.changed();
  }
}
