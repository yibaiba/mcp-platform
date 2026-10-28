import { z } from 'zod';
import { registryPage, registryRecord } from '@platform/contracts';
import { AppError } from '../../shared/errors.js';
export const OFFICIAL_REGISTRY = 'https://registry.modelcontextprotocol.io/v0.1/';
const REGISTRY_TIMEOUT_MS = 30_000;
export class RegistryClient {
  constructor(private readonly deps: { fetch: typeof fetch; baseUrl: string }) {}
  private async read(path: string, query: Record<string, string | undefined> = {}) {
    const url = new URL(path, this.deps.baseUrl);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.deps.fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      });
    } catch {
      throw new AppError(
        'REGISTRY_UNAVAILABLE',
        '官方 Registry 连接失败或超时；请检查网络后重试',
        502,
      );
    }
    if (!response.ok)
      throw new AppError(
        'REGISTRY_HTTP_ERROR',
        `官方 Registry 请求失败（HTTP ${response.status}）`,
        502,
      );
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new AppError('REGISTRY_RESPONSE', '官方 Registry 未返回完整 JSON', 502);
    }
  }
  async search(input: { search?: string; cursor?: string }) {
    return parseRegistry(registryPage, await this.read('servers', { ...input, version: 'latest' }));
  }
  async versions(name: string) {
    return parseRegistry(
      registryPage,
      await this.read(`servers/${encodeURIComponent(name)}/versions`),
    );
  }
  async detail(name: string, version: string) {
    return parseRegistry(
      registryRecord,
      await this.read(
        `servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
      ),
    );
  }
}

function parseRegistry<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(
      'REGISTRY_RESPONSE',
      `官方 Registry 字段格式无效：${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
      502,
    );
  return result.data;
}
