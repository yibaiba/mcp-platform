import { z } from 'zod';
import { DEFAULT_REQUEST_TIMEOUT_MS, requestOptions } from './requestOptions.js';
export * from './requestOptions.js';
export { clientPresets, type ClientPreset } from './clientPresets.js';
export {
  connectorPresets,
  matchesConnectorPreset,
  connectorAuthenticationLabels,
  type ConnectorPreset,
  type ConnectorAuthentication,
} from './connectorPresets.js';
export const PROTOCOL_VERSION = 1;
export const CALL_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS;
export const HEARTBEAT_MS = 15_000;
export const pairingLifetimeMs = 10 * 60_000;
export const idSchema = z.uuid();
export const httpUrl = z
  .url()
  .refine(
    (v) =>
      URL.canParse(v) &&
      ['http:', 'https:'].includes(new URL(v).protocol) &&
      !new URL(v).username &&
      !new URL(v).password &&
      !new URL(v).hash,
    '必须是 HTTP(S) 地址',
  );
export const connectionInput = z
  .object({
    name: z.string().trim().min(1),
    connectTimeoutMs: z.number().int().positive().default(CALL_TIMEOUT_MS),
    requestOptions: requestOptions.default({
      timeoutMs: CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: false,
    }),
    source: z.enum(['mcp', 'openapi']).default('mcp'),
    openapi: z
      .object({
        document: z.record(z.string(), z.unknown()),
        baseUrl: httpUrl,
        operations: z.array(z.string()).min(1),
        securityChoices: z.record(z.string(), z.number().int().nonnegative()).default({}),
        credentials: z
          .record(
            z.string(),
            z
              .object({
                value: z.string().optional(),
                username: z.string().optional(),
                password: z.string().optional(),
                clientId: z.string().optional(),
                clientSecret: z.string().optional(),
                tokenEndpointAuthMethod: z
                  .enum(['none', 'client_secret_post', 'client_secret_basic'])
                  .optional(),
                scopes: z.array(z.string()).default([]),
              })
              .strict(),
          )
          .default({}),
      })
      .strict()
      .optional(),
    adapter: z.enum(['direct', 'device', 'pi']),
    deviceId: idSchema.optional(),
    transport: z.enum(['http', 'sse', 'stdio']),
    mode: z.enum(['existing', 'managed']),
    url: httpUrl.optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    headers: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    credentialEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
    credentialHeaders: z.array(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)).default([]),
    identityMode: z.enum(['shared', 'independent']).default('shared'),
    forwardHeaders: z.array(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)).default([]),
    lifecycle: z
      .object({
        startup: z.enum(['eager', 'on-demand']).default('eager'),
        idleTimeoutMs: z.number().int().positive().optional(),
        shutdownGraceMs: z.number().int().nonnegative().default(5_000),
      })
      .default({ startup: 'eager', shutdownGraceMs: 5_000 }),
    health: z
      .object({
        enabled: z.boolean().default(false),
        intervalMs: z.number().int().positive().default(60_000),
        timeoutMs: z.number().int().positive().default(5_000),
        recover: z.boolean().default(false),
        initialIntervalMs: z.number().int().positive().default(5_000),
        maxIntervalMs: z.number().int().positive().default(300_000),
      })
      .refine(
        (value) => value.maxIntervalMs >= value.initialIntervalMs,
        '恢复最大间隔不能小于初始间隔',
      )
      .default({
        enabled: false,
        intervalMs: 60_000,
        timeoutMs: 5_000,
        recover: false,
        initialIntervalMs: 5_000,
        maxIntervalMs: 300_000,
      }),
    oauth: z
      .object({
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        scope: z.string().optional(),
        clientMetadataUrl: httpUrl.optional(),
        tokenEndpointAuthMethod: z
          .enum(['none', 'client_secret_post', 'client_secret_basic'])
          .optional(),
      })
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    for (const header of v.forwardHeaders)
      if (
        /^(authorization|proxy-authorization|cookie|set-cookie|host|origin|connection|content-length|content-type|accept|mcp-.*|last-event-id|transfer-encoding)$/i.test(
          header,
        )
      )
        fail(`请求头 ${header} 不允许动态转发`);
    if (v.source === 'openapi') {
      if (v.adapter !== 'direct' || !v.openapi) fail('OpenAPI 来源必须配置文档并在平台执行');
      if (v.transport !== 'http' || v.mode !== 'existing')
        fail('OpenAPI 来源不使用 MCP 传输或托管进程');
      return;
    }
    if (v.adapter === 'device' && !v.deviceId) fail('设备连接必须选择设备');
    if (v.adapter !== 'device' && v.deviceId) fail('平台执行的连接不能关联设备');
    if (v.adapter !== 'device' && v.mode === 'managed' && v.transport !== 'stdio')
      fail('HTTP/SSE 托管启动请选择设备连接器；平台支持托管 stdio 进程');
    if (v.transport !== 'stdio' && !v.url) fail('HTTP/SSE 必须填写 URL');
    if (v.mode === 'managed' && !v.command) fail('托管启动必须填写命令');
    if (v.transport === 'stdio' && v.mode !== 'managed') fail('stdio 必须托管启动进程');
    if (v.transport === 'stdio' && (v.url || v.oauth))
      fail('stdio 不使用 HTTP 地址或上游 OAuth；凭证请通过 env 配置');
  });
export type ConnectionInput = z.infer<typeof connectionInput>;
export type ImportPreview = {
  name: string;
  config: unknown;
  needsDevice: boolean;
  warnings: { field: string; message: string }[];
  errors: string[];
  authorization: string;
};
export const permissionSet = z
  .object({
    toolIds: z.array(z.string()).default([]),
    contentIds: z.array(z.string()).default([]),
    artifactIds: z.array(idSchema).default([]),
  })
  .strict();
export type PermissionSet = z.infer<typeof permissionSet>;
export const profileInput = z
  .object({
    name: z.string().trim().min(1),
    instructions: z.string().default(''),
    toolIds: z.array(z.string()).default([]),
    contentIds: z.array(z.string()).default([]),
    skillVersionIds: z.array(idSchema).default([]),
    artifactIds: z.array(idSchema).default([]),
    revision: z.number().int().positive().optional(),
    requestable: permissionSet.optional(),
    connectionIdentities: z
      .record(idSchema, z.enum(['inherit', 'profile', 'credential']))
      .optional(),
  })
  .strict();
export const callInput = z
  .object({
    arguments: z.record(z.string(), z.unknown()).default({}),
    interactionDeadline: z.iso.datetime().optional(),
  })
  .strict();
export const deviceResponse = z.discriminatedUnion('type', [
  z
    .object({
      v: z.literal(1),
      type: z.literal('notification'),
      connectionId: idSchema,
      method: z.enum([
        'notifications/tools/list_changed',
        'notifications/prompts/list_changed',
        'notifications/resources/list_changed',
        'notifications/resources/updated',
        'notifications/progress',
      ]),
      params: z.record(z.string(), z.unknown()).optional(),
      requestId: idSchema.optional(),
      sessionId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal('hello'),
      os: z.string(),
      version: z.string(),
      hostname: z.string(),
      capabilities: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal('heartbeat'),
      services: z.array(
        z.object({ id: idSchema, status: z.string(), error: z.string().optional() }),
      ),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      type: z.literal('result'),
      id: idSchema,
      result: z.unknown().optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    })
    .strict(),
]);
export type DeviceResponse = z.infer<typeof deviceResponse>;
export type DeviceRequest = {
  v: 1;
  type: 'request';
  id: string;
  method:
    | 'discover'
    | 'catalog'
    | 'mcp.request'
    | 'interaction.cancel'
    | 'check'
    | 'oauth.request'
    | 'call'
    | 'close'
    | 'skill.install'
    | 'artifact.receive'
    | 'artifact.send';
  deadline: string;
  params: Record<string, unknown>;
};
export const skillPackage = z
  .object({
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    files: z.record(z.string(), z.string()),
    dependencies: z.array(z.string()).default([]),
  })
  .strict();
export type SkillPackage = z.infer<typeof skillPackage>;
export { connectorTargets } from './connectorDistribution.js';
