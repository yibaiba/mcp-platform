import { marketSelection } from '@platform/contracts';
import type { ConnectionService } from '../mcp/connectionService.js';
import type { RegistryClient } from './registryClient.js';
import { compileRegistry, distributionFields, packageSupport } from './compiler.js';
import { fingerprint } from '../configuration/values.js';
import { AppError } from '../../shared/errors.js';
export class MarketService {
  constructor(
    private readonly deps: { registry: RegistryClient; connections: ConnectionService },
  ) {}
  search(input: { search?: string; cursor?: string }) {
    return this.deps.registry.search(input);
  }
  versions(name: string) {
    return this.deps.registry.versions(name);
  }
  async detail(name: string, version: string) {
    const record = await this.deps.registry.detail(name, version);
    return {
      ...record,
      choices: [
        ...record.server.packages.map((pkg, index) => ({
          distribution: 'package' as const,
          index,
          label: `${pkg.registryType} · ${pkg.identifier} · ${pkg.version ?? '未固定版本'}`,
          unsupported: packageSupport(pkg),
          fields: distributionFields(record.server, { distribution: 'package', index }),
        })),
        ...record.server.remotes.map((remote, index) => ({
          distribution: 'remote' as const,
          index,
          label: `${remote.type} · ${remote.url}`,
          unsupported: ['streamable-http', 'sse'].includes(remote.type)
            ? undefined
            : '不支持的远程传输',
          fields: distributionFields(record.server, { distribution: 'remote', index }),
        })),
      ],
    };
  }
  private async resolve(input: unknown) {
    const selected = marketSelection.parse(input);
    const record = await this.deps.registry.detail(selected.serverName, selected.version);
    const config = compileRegistry(record.server, selected);
    return { config, selected, hash: fingerprint({ server: record.server, config }) };
  }
  async preview(ownerId: string, input: unknown) {
    const resolved = await this.resolve(input);
    await this.deps.connections.validate(ownerId, resolved.config);
    // The preview includes argv exactly as executed. It is private to the requesting account.
    return {
      config: resolved.config,
      previewHash: resolved.hash,
      status: 'preview',
      note: '保存后才下载或启动；真实发现成功后才标记已连接',
    };
  }
  async install(ownerId: string, input: unknown) {
    const { config, selected, hash } = await this.resolve(input);
    if (selected.previewHash !== hash)
      throw new AppError(
        'MARKET_PREVIEW_CHANGED',
        '安装参数或 Registry 内容已变化，请重新预览',
        409,
      );
    const connection = await this.deps.connections.create(ownerId, config);
    try {
      const tools = await this.deps.connections.discover(ownerId, connection.id);
      return { connectionId: connection.id, status: 'connected', tools: tools.length };
    } catch (error) {
      return {
        connectionId: connection.id,
        status: 'error',
        error: this.deps.connections.redact(error, config),
      };
    }
  }
}
