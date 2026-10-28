import type { ProfileService } from '../agent-profiles/profileService.js';
import { toolDefinition } from '../discovery/discoveryService.js';
import { relocateSchema } from './schemaReferences.js';
export async function exportOpenApi(
  profiles: ProfileService,
  input: { ownerId: string; profileId: string; publicUrl: string },
) {
  const profile = await profiles.owned(input.ownerId, input.profileId);
  const rows = await profiles.catalog(input.ownerId, input.profileId);
  const inputs = Object.fromEntries(
    rows.map((row) => [
      `Input_${row.id}`,
      relocateSchema(toolDefinition(row).inputSchema, `Input_${row.id}`),
    ]),
  );
  const paths = Object.fromEntries(
    rows.map((row) => {
      const tool = toolDefinition(row);
      return [
        `/mcp/${profile.id}/rest/tools/${encodeURIComponent(row.id)}`,
        {
          post: {
            operationId: row.exposedName,
            description: tool.description,
            parameters: [
              {
                in: 'header',
                name: 'Idempotency-Key',
                required: false,
                schema: { type: 'string', minLength: 1 },
                description: '同一凭证和请求返回既有调用；不同请求使用相同 key 返回 409。',
              },
            ],
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: { $ref: `#/components/schemas/Input_${row.id}` } },
              },
            },
            responses: {
              '200': {
                description: '实际 MCP 工具结果（包含 isError、content、structuredContent 等）',
                content: {
                  'application/json': { schema: { type: 'object', additionalProperties: true } },
                },
              },
              '202': {
                description:
                  '调用正在执行或等待交互；使用返回的 callId、interactionId 和 links 续传',
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/CallStatus' } },
                },
              },
              '409': { description: '幂等冲突、交互重复或结果尚不可用' },
            },
          },
        },
      ];
    }),
  );
  const callPath = `/mcp/${profile.id}/rest/calls/{callId}`;
  const parameter = {
    in: 'path',
    name: 'callId',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  };
  const continuation = {
    [callPath]: {
      get: {
        operationId: 'platform_rest_status',
        parameters: [parameter],
        responses: {
          '200': {
            description: '当前调用状态及交互内容',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CallStatus' } },
            },
          },
        },
      },
    },
    [`${callPath}/result`]: {
      get: {
        operationId: 'platform_rest_result',
        parameters: [parameter],
        responses: {
          '200': { description: '持久化的实际 MCP 结果' },
          '409': { description: '结果尚未就绪或未知' },
        },
      },
    },
    [`${callPath}/cancel`]: {
      post: {
        operationId: 'platform_rest_cancel',
        parameters: [parameter],
        responses: { '200': { description: '取消后的状态；上游执行结果可能未知' } },
      },
    },
    [`${callPath}/answer`]: {
      post: {
        operationId: 'platform_rest_answer',
        parameters: [parameter],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['interactionId', 'responses'],
                properties: {
                  interactionId: { type: 'string', format: 'uuid' },
                  responses: {
                    type: 'object',
                    additionalProperties: {
                      type: 'object',
                      required: ['action'],
                      properties: {
                        action: { type: 'string', enum: ['accept', 'decline', 'cancel'] },
                        content: { type: 'object' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: '实际 MCP 结果' },
          '202': { description: '下一轮交互' },
          '409': { description: '回答已提交或交互不匹配' },
        },
      },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: profile.name,
      version: String(profile.revision),
      description:
        '使用当前 Profile 的 Agent key 或 OAuth access token。所有接口重新检查当前权限；REST 不提供 Apps 渲染宿主。',
    },
    servers: [{ url: input.publicUrl }],
    security: [{ bearerAuth: [] }],
    paths: { ...paths, ...continuation },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: {
        ...inputs,
        CallStatus: {
          type: 'object',
          required: ['callId', 'status', 'links'],
          properties: {
            callId: { type: 'string', format: 'uuid' },
            status: { type: 'string' },
            interactionId: { type: 'string', format: 'uuid' },
            inputRequests: { type: 'object' },
            links: { type: 'object', additionalProperties: { type: 'string' } },
          },
        },
      },
    },
  };
}
