import { z } from 'zod';
export const activitySearch = z.object({
  from: z.string().optional(),
  before: z.string().optional(),
  profileId: z.string().optional(),
  taskId: z.string().optional(),
  connectionId: z.string().optional(),
  deviceId: z.string().optional(),
  toolId: z.string().optional(),
  status: z.string().optional(),
  callId: z.string().optional(),
});
export type ActivitySearch = z.infer<typeof activitySearch>;
export const callStatuses = [
  { id: 'running', name: '执行中' },
  { id: 'waiting', name: '等待上游交互' },
  { id: 'succeeded', name: '成功' },
  { id: 'tool_error', name: '工具返回错误' },
  { id: 'failed', name: '失败' },
  { id: 'unknown', name: '结果未知' },
  { id: 'cancelled', name: '已取消' },
];
