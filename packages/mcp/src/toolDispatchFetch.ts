/** Authentication may recover discovery; a dispatched tool request is never implicitly sent twice. */
export function toolDispatchFetch(
  fetch: typeof globalThis.fetch,
  beforeTool?: () => Promise<Record<string, string>>,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    let tool = false;
    if (request.method === 'POST') {
      const text = await request.clone().text();
      try {
        tool = (JSON.parse(text) as { method?: string }).method === 'tools/call';
      } catch {
        /* Non-JSON OAuth/form requests are forwarded unchanged. */
      }
    }
    if (tool && beforeTool) {
      const headers = await beforeTool();
      for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
    }
    const response = await fetch(request);
    if (tool && [401, 403].includes(response.status))
      throw new Error(`上游工具授权被拒绝（HTTP ${response.status}）；请求未重放，请重新授权`);
    return response;
  };
}
