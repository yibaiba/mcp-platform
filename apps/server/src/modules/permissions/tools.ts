import type { Tool } from '@platform/mcp';
import type { RequestService } from './requestService.js';
import type { Access } from './accessService.js';
import type { permissionRequests } from '@platform/db';
export const permissionTools: Tool[] = [
  {
    name: 'platform_permissions_catalog',
    description: '查看当前主体可申请的权限目录；可申请不代表可执行。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'platform_permissions_request',
    description:
      '提交权限申请。外部客户端立即收到申请记录，须使用 platform_permissions_status 查询决定；内置 Pi 会等待用户决定。批准本身不会执行业务操作，之后须发起新的业务调用。',
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
export function externalPermissionResult(
  request: typeof permissionRequests.$inferSelect,
  webOrigin: string,
) {
  const approval = new URL('/profiles', webOrigin);
  approval.searchParams.set('workspace', request.profileId);
  return {
    ...request,
    approvalUrl: approval.href,
    statusTool: 'platform_permissions_status',
    next:
      request.status === 'pending'
        ? '请用户在审批入口处理申请，再用 platform_permissions_status 查询；当前业务尚未执行。'
        : request.status === 'approved'
          ? '审批已批准，请刷新工具目录并发起新的业务调用；平台没有自动执行业务。'
          : '申请已结束且未获批准，请勿执行依赖本次申请的操作。',
  };
}
