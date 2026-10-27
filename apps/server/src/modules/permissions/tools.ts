import type { Tool } from '@platform/mcp';
import type { RequestService } from './requestService.js';
import type { Access } from './accessService.js';
export const permissionTools: Tool[] = [
  {
    name: 'platform_permissions_catalog',
    description: '查看当前主体可申请的权限目录；可申请不代表可执行。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'platform_permissions_request',
    description: '申请权限并等待用户决定；批准本身不会执行业务操作，之后须发起新的业务调用。',
    inputSchema: {
      type: 'object',
      properties: {
        permissions: {
          type: 'object',
          properties: {
            toolIds: { type: 'array', items: { type: 'string' } },
            contentIds: { type: 'array', items: { type: 'string' } },
            artifactIds: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        reason: { type: 'string' },
        idempotencyKey: { type: 'string' },
        deadline: { type: 'string', format: 'date-time' },
      },
      required: ['permissions', 'reason', 'idempotencyKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'platform_permissions_status',
    description: '查询当前主体的权限申请状态。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];
export async function availablePermissionTools(requests: RequestService, access: Access) {
  return (await requests.enabled(access)) ? permissionTools : [];
}
