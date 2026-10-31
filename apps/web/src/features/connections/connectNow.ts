import { api } from '../../lib/api.js';

/** Result of "保存并连接": saved for sure, connected only when `error` is absent. */
export type ConnectOutcome = {
  connectionId: string;
  tools?: number;
  error?: Error & { code?: string };
};

export async function connectNow(connectionId: string): Promise<ConnectOutcome> {
  try {
    const tools = await api<unknown[]>(`/connections/${connectionId}/discover`, { method: 'POST' });
    return { connectionId, tools: tools.length };
  } catch (error) {
    return { connectionId, error: error instanceof Error ? error : new Error(String(error)) };
  }
}
