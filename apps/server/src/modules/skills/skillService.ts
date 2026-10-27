import { and, eq, desc } from 'drizzle-orm';
import { skillVersions, installations, type Database } from '@platform/db';
import { validatePackage } from './packageService.js';
import type { DeviceBroker } from '../devices/deviceBroker.js';
import type { DeviceService } from '../devices/deviceService.js';
import type { ProfileService } from '../agent-profiles/profileService.js';
import { AppError, errorMessage, requireValue } from '../../shared/errors.js';
export class SkillService {
  constructor(
    private readonly deps: {
      db: Database;
      broker: DeviceBroker;
      devices: DeviceService;
      profiles: ProfileService;
    },
  ) {}
  list(ownerId: string) {
    return this.deps.db
      .select({
        id: skillVersions.id,
        name: skillVersions.name,
        digest: skillVersions.digest,
        source: skillVersions.source,
        revision: skillVersions.revision,
        dependencies: skillVersions.dependencies,
        createdAt: skillVersions.createdAt,
      })
      .from(skillVersions)
      .where(eq(skillVersions.ownerId, ownerId))
      .orderBy(desc(skillVersions.createdAt));
  }
  async version(ownerId: string, id: string) {
    const [row] = await this.deps.db
      .select()
      .from(skillVersions)
      .where(and(eq(skillVersions.id, id), eq(skillVersions.ownerId, ownerId)));
    return requireValue(row);
  }
  async import(ownerId: string, input: { package: unknown; source: string; revision?: string }) {
    const value = validatePackage(input.package);
    const catalog = await this.deps.profiles.catalog(ownerId);
    if (value.dependencies.some((id) => !catalog.some((tool) => tool.id === id)))
      throw new AppError('SKILL_DEPENDENCY', 'Skill 关联了不存在的 MCP 工具');
    const [existing] = await this.deps.db
      .select()
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.ownerId, ownerId),
          eq(skillVersions.name, value.name),
          eq(skillVersions.digest, value.digest),
        ),
      );
    if (existing) {
      if (
        JSON.stringify(existing.dependencies.slice().sort()) !==
        JSON.stringify(value.dependencies.slice().sort())
      )
        throw new AppError('IMMUTABLE_VERSION', '相同内容的版本已存在，不能修改其依赖');
      return existing;
    }
    const [row] = await this.deps.db
      .insert(skillVersions)
      .values({
        ownerId,
        name: value.name,
        files: value.files,
        digest: value.digest,
        dependencies: value.dependencies,
        source: input.source,
        revision: input.revision,
      })
      .returning();
    return row;
  }
  async install(
    ownerId: string,
    input: {
      versionId: string;
      profileId: string;
      deviceId: string;
      target: string;
      signal?: AbortSignal;
    },
  ) {
    const version = await this.version(ownerId, input.versionId);
    await this.deps.devices.owned(ownerId, input.deviceId);
    const profile = await this.deps.profiles.owned(ownerId, input.profileId);
    if (version.dependencies.some((id) => !profile.toolIds.includes(id)))
      throw new AppError('SKILL_DEPENDENCY', 'Agent 配置未授权 Skill 所需工具');
    const [record] = await this.deps.db
      .insert(installations)
      .values({
        ownerId,
        deviceId: input.deviceId,
        profileId: input.profileId,
        versionId: input.versionId,
        target: input.target,
        status: 'installing',
      })
      .returning();
    const id = requireValue(record).id;
    try {
      const result = await this.deps.broker.request(input.deviceId, {
        method: 'skill.install',
        params: {
          name: version.name,
          files: version.files,
          digest: version.digest,
          target: input.target,
        },
        signal: input.signal,
      });
      await this.deps.db
        .update(installations)
        .set({ status: 'installed' })
        .where(eq(installations.id, id));
      return { id, result, reloadRequired: true, loadedVerified: false };
    } catch (error) {
      await this.deps.db
        .update(installations)
        .set({ status: 'failed', error: errorMessage(error) })
        .where(eq(installations.id, id));
      throw error;
    }
  }
}
