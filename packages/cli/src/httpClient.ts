import { z } from 'zod';
import { CliError } from './errors.js';
import type { ConfigStore, CliConfig } from './configStore.js';
export const tokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number().positive(),
  grant_id: z.string(),
  scope: z.string(),
});
export type HttpResult = { body: unknown; callId: string | null; status: number };
export class HttpClient {
  constructor(
    private readonly deps: {
      fetch: typeof fetch;
      store: ConfigStore;
      env: NodeJS.ProcessEnv;
      environment?: string;
    },
  ) {}
  async environment() {
    const config = await this.deps.store.read();
    const name = this.deps.environment ?? config.current;
    const environment = name ? config.environments[name] : undefined;
    if (!name || !environment)
      throw new CliError('请先使用 env add 配置平台并用 env use 选择环境', 2);
    return { config, name, environment };
  }
  async exchange(url: string, body: unknown) {
    const result = await this.send(new URL('/api/v1/cli/token', url), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
    return tokenResponse.parse(result.body);
  }
  async saveTokens(input: {
    config: CliConfig;
    name: string;
    token: z.infer<typeof tokenResponse>;
  }) {
    const environment = input.config.environments[input.name]!;
    await this.deps.store.write({
      ...input.config,
      environments: {
        ...input.config.environments,
        [input.name]: {
          ...environment,
          credentials: {
            accessToken: input.token.access_token,
            refreshToken: input.token.refresh_token,
            expiresAt: Date.now() + input.token.expires_in * 1000,
            grantId: input.token.grant_id,
            scope: input.token.scope,
          },
        },
      },
    });
  }
  private async managementToken() {
    if (this.deps.env.MCP_PLATFORM_ACCESS_TOKEN) return this.deps.env.MCP_PLATFORM_ACCESS_TOKEN;
    const { config, name, environment } = await this.environment();
    const credential = environment.credentials;
    if (!credential) throw new CliError('当前环境尚未登录，请运行 login', 3);
    if (credential.expiresAt > Date.now()) return credential.accessToken;
    const token = await this.exchange(environment.url, {
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
    });
    await this.saveTokens({ config, name, token });
    return token.access_token;
  }
  async request(input: {
    path: string;
    method?: string;
    body?: unknown;
    agent?: boolean;
    idempotencyKey?: string;
  }) {
    const { environment } = await this.environment();
    const token = input.agent
      ? this.deps.env.MCP_PLATFORM_AGENT_TOKEN
      : await this.managementToken();
    if (!token)
      throw new CliError(
        '业务调用需要 MCP_PLATFORM_AGENT_TOKEN 和 --profile；管理令牌不能调用工具',
        3,
      );
    return this.send(new URL(input.path, environment.url), {
      method: input.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
  }
  private async send(url: URL, input: RequestInit): Promise<HttpResult> {
    let response: Response;
    try {
      response = await this.deps.fetch(url, { ...input, redirect: 'error' });
    } catch {
      throw new CliError('连接平台失败；操作未自动重试。业务调用请核实原调用状态', 4);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CliError(`平台未返回 JSON（HTTP ${response.status}）`, 4);
    }
    if (!response.ok) {
      const parsed = z
        .object({ error: z.string().optional(), code: z.string().optional() })
        .passthrough()
        .safeParse(body);
      const message = parsed.success ? (parsed.data.error ?? parsed.data.code) : undefined;
      throw new CliError(
        `${message ?? `HTTP ${response.status}`}${response.headers.get('X-Call-Id') ? `；调用 ID ${response.headers.get('X-Call-Id')}` : ''}`,
        response.status === 401 || response.status === 403 ? 3 : response.status === 400 ? 2 : 4,
      );
    }
    return { body, callId: response.headers.get('X-Call-Id'), status: response.status };
  }
}
