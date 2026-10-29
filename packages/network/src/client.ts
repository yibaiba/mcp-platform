import { Agent, ProxyAgent, type Dispatcher } from 'undici';
import type { NetworkConfig } from '@platform/contracts';
import { bypassProxy } from './noProxy.js';
import { githubTarget, stripCrossOriginHeaders } from './github.js';
const MAX_REDIRECTS = 20; // Fetch standard redirect limit; loops must fail explicitly.
export class NetworkClient {
  private readonly agents = new Map<string, Dispatcher>();
  private readonly direct = new Agent();
  private readonly shutdown = new AbortController();
  constructor(
    private readonly config: NetworkConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  private dispatcher(url: URL) {
    const secure = url.protocol === 'https:';
    const proxy = secure ? this.config.httpsProxy || this.config.httpProxy : this.config.httpProxy;
    if (!proxy || bypassProxy(url, this.config.noProxy)) return this.direct;
    const auth =
      secure && this.config.httpsProxy
        ? this.config.secrets.httpsProxyAuth
        : this.config.secrets.httpProxyAuth;
    const key = JSON.stringify([proxy, auth]);
    let agent = this.agents.get(key);
    if (!agent) {
      agent = new ProxyAgent({
        uri: proxy,
        ...(auth ? { token: `Basic ${Buffer.from(auth).toString('base64')}` } : {}),
      });
      this.agents.set(key, agent);
    }
    return agent;
  }
  fetch: typeof fetch = async (input, init) => {
    let request = new Request(input, init);
    request = new Request(request, {
      signal: AbortSignal.any([request.signal, this.shutdown.signal]),
    });
    request = rewriteRequest(request, this.config);
    for (let redirects = 0; ; redirects++) {
      const replay = request.clone();
      const response = await this.request(request, {
        redirect: 'manual',
        dispatcher: this.dispatcher(new URL(request.url)),
      } as RequestInit);
      const location = response.headers.get('location');
      if (
        ![301, 302, 303, 307, 308].includes(response.status) ||
        !location ||
        request.redirect === 'manual'
      )
        return response;
      await response.body?.cancel();
      if (request.redirect === 'error' || redirects >= MAX_REDIRECTS)
        throw new Error('网络请求重定向失败');
      request = redirectedRequest({ request, response, replay, location });
    }
  };
  async retire() {
    await Promise.all([
      this.direct.close(),
      ...[...this.agents.values()].map((agent) => agent.close()),
    ]);
  }
  async close() {
    // Shutdown must also terminate unconsumed streaming responses. Rotation uses retire().
    this.shutdown.abort(new DOMException('Network client closed', 'AbortError'));
    await Promise.all([
      this.direct.destroy(),
      ...[...this.agents.values()].map((agent) => agent.destroy()),
    ]);
  }
}

function rewriteRequest(request: Request, config: NetworkConfig) {
  // File/API acceleration must not forward OAuth or other submitted credentials.
  if (!['GET', 'HEAD'].includes(request.method)) return request;
  const target = githubTarget(new URL(request.url), config);
  if (target.url.href === request.url && !target.token) return request;
  const headers = new Headers(request.headers);
  if (target.url.origin !== new URL(request.url).origin) stripCrossOriginHeaders(headers);
  if (target.token) headers.set('Authorization', `Bearer ${target.token}`);
  return new Request(target.url, new Request(request, { headers }));
}
function redirectedRequest(input: {
  request: Request;
  response: Response;
  replay: Request;
  location: string;
}) {
  const { request, response, replay, location } = input;
  const next = new URL(location, request.url);
  if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password)
    throw new Error('无效的重定向地址');
  const headers = new Headers(request.headers);
  if (next.origin !== new URL(request.url).origin) stripCrossOriginHeaders(headers);
  const get =
    (response.status === 303 && request.method !== 'HEAD') ||
    ([301, 302].includes(response.status) && request.method === 'POST');
  rejectGithubBodyRedirect(request, next, get);
  if (get) {
    headers.delete('content-type');
    headers.delete('content-length');
  }
  return get
    ? new Request(next, { method: 'GET', headers, signal: request.signal })
    : new Request(next, new Request(replay, { headers }));
}

function rejectGithubBodyRedirect(request: Request, target: URL, changesToGet: boolean) {
  const original = new URL(request.url);
  const github = original.hostname === 'github.com' || original.hostname.endsWith('.github.com');
  if (github && request.body && !changesToGet && original.origin !== target.origin)
    throw new Error('不能跨域重定向 GitHub 请求体；请检查原始端点');
}
