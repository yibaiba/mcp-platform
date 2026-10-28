import { and, eq, inArray } from 'drizzle-orm';
import {
  connections,
  connectionShares,
  configManifests,
  profiles,
  tools,
  mcpEntries,
  artifacts,
  skillVersions,
  user,
  type Database,
} from '@platform/db';
import {
  configManifest,
  type ConfigManifest,
  type ConnectionInput,
  type ManifestProfile,
} from '@platform/contracts';
import type { Vault } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import { fingerprint } from './values.js';
import { DeploymentPending } from './values.js';
import { assertDeploymentReady } from './readiness.js';

export class ConfigExportService {
  constructor(private readonly deps: { db: Database; vault: Vault }) {}
  async export(ownerId: string, name: string): Promise<ConfigManifest> {
    const manifests = await this.deps.db
      .select({ status: configManifests.status })
      .from(configManifests)
      .where(eq(configManifests.ownerId, ownerId));
    if (manifests.some((manifest) => manifest.status !== 'ready'))
      throw new DeploymentPending(
        '存在尚未就绪的配置模板，不能导出旧配置；请从模板状态读取已保存的完整 declaration',
      );
    const own = await this.deps.db
      .select()
      .from(connections)
      .where(eq(connections.ownerId, ownerId));
    const incoming = await this.deps.db
      .select({ share: connectionShares, connection: connections })
      .from(connectionShares)
      .innerJoin(connections, eq(connections.id, connectionShares.connectionId))
      .where(and(eq(connectionShares.recipientId, ownerId), eq(connectionShares.revoked, false)));
    const sourceNames = new Map([
      ...own.map((row) => [row.id, row.name] as const),
      ...incoming.map(({ connection }) => [connection.id, `shared-${connection.name}`] as const),
    ]);
    this.unique([...sourceNames.values()], '连接');
    const declarations: ConfigManifest['connections'] = {};
    for (const row of own) {
      const input = this.deps.vault.open<ConnectionInput>(row.config, `${ownerId}:${row.id}`);
      const { deviceId, ...config } = input;
      declarations[row.name] = {
        config: this.redactConfig(row.name, config),
        ...(deviceId ? { deviceRef: `device-${row.name}` } : {}),
      };
    }
    for (const { connection } of incoming)
      declarations[sourceNames.get(connection.id)!] = {
        sharedRef: sourceNames.get(connection.id)!,
      };
    const ids = [...sourceNames.keys()];
    const toolRows = ids.length
      ? await this.deps.db.select().from(tools).where(inArray(tools.connectionId, ids))
      : [];
    const contentRows = ids.length
      ? await this.deps.db.select().from(mcpEntries).where(inArray(mcpEntries.connectionId, ids))
      : [];
    const rows = await this.deps.db.select().from(profiles).where(eq(profiles.ownerId, ownerId));
    for (const row of rows) assertDeploymentReady(row);
    this.unique(
      rows.map((row) => row.name),
      'Profile',
    );
    const result: ConfigManifest = {
      version: 1,
      name,
      connections: declarations,
      profiles: {},
      shares: {},
    };
    const toolRef = (id: string) => {
      const row = toolRows.find((row) => row.id === id);
      if (!row)
        throw new AppError('MANIFEST_EXPORT_REFERENCE', 'Profile 中存在未解析工具；请先修正授权');
      return {
        connection: sourceNames.get(row.connectionId)!,
        name: row.name,
        hiddenParameters: [] as string[],
      };
    };
    const contentRef = (id: string) => {
      const row = contentRows.find((row) => row.id === id);
      if (!row)
        throw new AppError('MANIFEST_EXPORT_REFERENCE', 'Profile 中存在未解析内容；请先修正授权');
      return {
        connection: sourceNames.get(row.connectionId)!,
        kind: row.kind,
        locator: row.locator,
      };
    };
    for (const row of rows) {
      const capability = async (set: {
        toolIds: string[];
        contentIds: string[];
        artifactIds: string[];
      }) => ({
        tools: set.toolIds.map((id) => ({ ...toolRef(id), ...row.catalog.tools[id] })),
        content: set.contentIds.map((id) => ({ ...contentRef(id), ...row.catalog.content[id] })),
        artifacts: await this.fileRefs(ownerId, set.artifactIds),
      });
      const value: ManifestProfile = {
        ...(await capability(row)),
        name: row.name,
        instructions: row.instructions,
        skills: await this.skillRefs(ownerId, row.skillVersionIds),
        requestable: await capability(row.requestable),
        toolNaming: row.catalog.toolNaming,
        connectionAliases: Object.fromEntries(
          Object.entries(row.catalog.connectionAliases).map(([id, alias]) => [
            this.source(sourceNames, id),
            alias,
          ]),
        ),
        connectionIdentities: Object.fromEntries(
          Object.entries(row.connectionIdentities).map(([id, mode]) => [
            this.source(sourceNames, id),
            mode,
          ]),
        ),
      };
      result.profiles[row.name] = value;
    }
    const outgoing = await this.deps.db
      .select({ grant: connectionShares, email: user.email })
      .from(connectionShares)
      .innerJoin(user, eq(user.id, connectionShares.recipientId))
      .where(and(eq(connectionShares.ownerId, ownerId), eq(connectionShares.revoked, false)));
    for (const { grant, email } of outgoing) {
      const recipientRef = `user-${fingerprint(email).slice(0, 16)}`;
      const connection = this.source(sourceNames, grant.connectionId);
      result.shares[`${connection}-${recipientRef}`] = {
        connection,
        recipientRef,
        credentialMode: grant.credentialMode,
        tools: grant.toolIds.map((id) => toolRef(id).name),
        content: grant.contentIds.map((id) => {
          const { connection: _connection, ...value } = contentRef(id);
          return value;
        }),
      };
    }
    return configManifest.parse(result);
  }
  private unique(names: string[], kind: string) {
    if (new Set(names).size !== names.length)
      throw new AppError('MANIFEST_EXPORT_NAME', `${kind}名称重复；请明确命名后导出`, 409);
  }
  private source(names: Map<string, string>, id: string) {
    const name = names.get(id);
    if (!name)
      throw new AppError('MANIFEST_EXPORT_REFERENCE', 'Profile 中存在未解析连接；请先修正配置');
    return name;
  }
  private redactConfig(name: string, config: Omit<ConnectionInput, 'deviceId'>) {
    const secret = (path: string) => ({
      secretRef: `secret-${fingerprint(`${name}:${path}`).slice(0, 24)}`,
    });
    return {
      ...config,
      args: config.args,
      ...(config.url && new URL(config.url).search ? { url: secret('url') } : {}),
      ...(config.cwd ? { cwd: { directoryRef: `cwd-${name}` } } : {}),
      env: Object.fromEntries(Object.keys(config.env).map((key) => [key, secret(`env.${key}`)])),
      headers: Object.fromEntries(
        Object.keys(config.headers).map((key) => [key, secret(`headers.${key}`)]),
      ),
      ...(config.oauth
        ? {
            oauth: {
              ...config.oauth,
              ...(config.oauth.clientSecret ? { clientSecret: secret('oauth.clientSecret') } : {}),
            },
          }
        : {}),
      ...(config.openapi
        ? {
            openapi: {
              ...config.openapi,
              credentials: Object.fromEntries(
                Object.entries(config.openapi.credentials).map(([key, value]) => [
                  key,
                  Object.fromEntries(
                    Object.entries(value).map(([field, value]) => [
                      field,
                      ['value', 'password', 'clientSecret'].includes(field)
                        ? secret(`openapi.${key}.${field}`)
                        : value,
                    ]),
                  ),
                ]),
              ),
            },
          }
        : {}),
    };
  }
  private async fileRefs(ownerId: string, ids: string[]) {
    const rows = ids.length
      ? await this.deps.db
          .select()
          .from(artifacts)
          .where(and(eq(artifacts.ownerId, ownerId), inArray(artifacts.id, ids)))
      : [];
    return ids.map((id) => {
      const row = rows.find((row) => row.id === id);
      if (!row) throw new AppError('MANIFEST_EXPORT_REFERENCE', '产物引用已失效');
      return `artifact-${row.sha256}`;
    });
  }
  private async skillRefs(ownerId: string, ids: string[]) {
    const rows = ids.length
      ? await this.deps.db
          .select()
          .from(skillVersions)
          .where(and(eq(skillVersions.ownerId, ownerId), inArray(skillVersions.id, ids)))
      : [];
    return ids.map((id) => {
      const row = rows.find((row) => row.id === id);
      if (!row) throw new AppError('MANIFEST_EXPORT_REFERENCE', 'Skill 引用已失效');
      return `skill-${row.digest}`;
    });
  }
}
