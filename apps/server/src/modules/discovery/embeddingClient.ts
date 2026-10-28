import { z } from 'zod';
import type { EmbeddingConfig } from '@platform/contracts';
import { AppError } from '../../shared/errors.js';
const responseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number().finite()).min(1),
    }),
  ),
});
export class EmbeddingClient {
  constructor(private readonly fetch: typeof globalThis.fetch) {}
  async embed(input: {
    config: EmbeddingConfig;
    texts: readonly string[];
    apiKey?: string;
    signal?: AbortSignal;
  }) {
    const url = new URL(
      'embeddings',
      input.config.baseUrl.endsWith('/') ? input.config.baseUrl : `${input.config.baseUrl}/`,
    );
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: input.config.model,
          input: input.texts,
          encoding_format: 'float',
          ...(input.config.dimensions ? { dimensions: input.config.dimensions } : {}),
        }),
        signal: AbortSignal.any([
          AbortSignal.timeout(input.config.timeoutMs),
          ...(input.signal ? [input.signal] : []),
        ]),
      });
    } catch {
      throw new AppError(
        'EMBEDDING_UNAVAILABLE',
        'Embedding 请求中断或连接失败；请检查地址、网络和超时配置',
        502,
      );
    }
    if (!response.ok)
      throw new AppError(
        'EMBEDDING_HTTP_ERROR',
        `Embedding 服务返回 HTTP ${response.status}；请检查模型和凭证配置`,
        502,
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AppError('EMBEDDING_RESPONSE', 'Embedding 服务未返回完整 JSON 响应', 502);
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success)
      throw new AppError('EMBEDDING_RESPONSE', 'Embedding 服务返回了无效向量格式', 502);
    const data = parsed.data.data;
    if (
      data.length !== input.texts.length ||
      new Set(data.map((row) => row.index)).size !== data.length ||
      data.some((row) => row.index >= input.texts.length)
    )
      throw new AppError('EMBEDDING_RESPONSE', 'Embedding 响应的条目数或索引不匹配', 502);
    const vectors = data.sort((a, b) => a.index - b.index).map((row) => normalize(row.embedding));
    const dimensions = input.config.dimensions ?? vectors[0]?.length;
    if (vectors.some((vector) => vector.length !== dimensions))
      throw new AppError('EMBEDDING_DIMENSIONS', 'Embedding 响应维度不一致', 502);
    return vectors;
  }
}
export function normalize(vector: readonly number[]) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0)
    throw new AppError('EMBEDDING_VECTOR', 'Embedding 返回了零向量或不可计算的向量', 502);
  return vector.map((value) => value / magnitude);
}
export function cosine(left: readonly number[], right: readonly number[]) {
  if (left.length !== right.length)
    throw new AppError('EMBEDDING_DIMENSIONS', '检索向量维度与目录索引不一致', 409);
  return left.reduce((sum, value, index) => sum + value * right[index]!, 0);
}
