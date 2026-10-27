import { z } from 'zod';
import { connectionInput, type ConnectionInput, type ImportPreview } from '@platform/contracts';
import type { ConnectionService } from './connectionService.js';
import { AppError } from '../../shared/errors.js';
const imported = z
  .object({
    mcpServers: z.record(
      z.string(),
      z
        .object({
          url: z.string().optional(),
          command: z.string().optional(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
          headers: z.record(z.string(), z.string()).optional(),
          cwd: z.string().optional(),
          type: z.string().optional(),
        })
        .passthrough(),
    ),
    deviceId: z.uuid().optional(),
  })
  .strict();
const mappedFields = new Set(['url', 'command', 'args', 'env', 'headers', 'cwd', 'type']);
const transportTypes = new Map<string, ConnectionInput['transport']>([
  ['stdio', 'stdio'],
  ['sse', 'sse'],
  ['streamable-http', 'http'],
  ['http', 'http'],
]);
function declaration(
  name: string,
  server: z.infer<typeof imported>['mcpServers'][string],
  deviceId?: string,
): ImportPreview {
  const transport =
    server.type !== undefined ? transportTypes.get(server.type) : server.command ? 'stdio' : 'http';
  const device = transport === 'stdio';
  const config = {
    name,
    adapter: device ? 'device' : 'direct',
    deviceId: device ? deviceId : undefined,
    transport,
    mode: device ? 'managed' : 'existing',
    url: server.url,
    command: server.command,
    args: server.args ?? [],
    env: server.env ?? {},
    headers: server.headers ?? {},
    cwd: server.cwd,
  };
  const needsDevice = device && !deviceId;
  const checked = connectionInput.safeParse(config);
  const errors = checked.success ? [] : checked.error.issues.map((issue) => issue.message);
  if (!transport) errors.push(`不支持导入传输类型 ${server.type}；OpenAPI 等适配器需单独迁移`);
  return {
    name,
    config,
    needsDevice,
    warnings: Object.keys(server)
      .filter((field) => !mappedFields.has(field))
      .map((field) => ({
        field,
        message:
          field === 'oauth'
            ? 'OAuth 配置与凭证不会迁移，请在新连接中重新配置并授权'
            : `字段 ${field} 尚未映射，导入后不会生效，请核对原配置`,
      })),
    errors,
    authorization: '不会迁移 OAuth 凭证，受保护连接需重新授权',
  };
}
export function previewImport(input: unknown) {
  const value = imported.parse(input);
  return Object.entries(value.mcpServers).map(([name, server]) =>
    declaration(name, server, value.deviceId),
  );
}
export async function previewOwnedImport(
  service: ConnectionService,
  ownerId: string,
  input: unknown,
) {
  const preview = previewImport(input);
  await Promise.all(
    preview.filter((row) => !row.errors.length).map((row) => service.validate(ownerId, row.config)),
  );
  return preview;
}
export async function applyImport(service: ConnectionService, ownerId: string, input: unknown) {
  const preview = await previewOwnedImport(service, ownerId, input);
  const errors = preview.flatMap((row) => row.errors.map((message) => `${row.name}: ${message}`));
  if (errors.length) throw new AppError('IMPORT_INVALID', errors.join('; '));
  return service.createMany(
    ownerId,
    preview.map((row) => row.config),
  );
}
