import { authorizationResult } from './authorizationResult.js';

export async function authorizeConnection(options: {
  endpoint: string;
  request: (path: string, options?: RequestInit) => Promise<unknown>;
  navigate: (url: string) => void;
}) {
  const result = await options.request(`${options.endpoint}/start`, { method: 'POST' });
  const { url, authorized } = authorizationResult(result);
  if (url) {
    options.navigate(url.href);
    return result;
  }
  if (!authorized) throw new Error('授权服务未返回有效授权地址或已授权状态，请查看连接诊断');
  const connected = await options.request(`${options.endpoint}/discover`, { method: 'POST' });
  return { status: 'AUTHORIZED', authorization: result, connected };
}
