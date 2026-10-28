import SwaggerParser from '@apidevtools/swagger-parser';
import { z } from 'zod';
import { httpUrl } from '@platform/contracts';
import type { ApiDocument } from './types.js';
import { compileDocument } from './compile.js';
import type { ArtifactService } from '../artifacts/artifactService.js';
import { AppError } from '../../shared/errors.js';
import { schemaDataMatcher } from './schemaData.js';
const inputSchema = z
  .object({
    url: httpUrl.optional(),
    artifactId: z.uuid().optional(),
    referenceOrigins: z.array(httpUrl).default([]),
    documentHeaders: z.record(z.string(), z.string()).default({}),
    referenceHeaders: z.record(httpUrl, z.record(z.string(), z.string())).default({}),
  })
  .strict()
  .refine((v) => Boolean(v.url) !== Boolean(v.artifactId), '选择文档 URL 或产物 ID');
export async function validateOpenApiDocument(document: Record<string, unknown>) {
  const source = 'https://platform-inline.invalid/openapi.json';
  const excludedPathMatcher = schemaDataMatcher();
  try {
    return await new SwaggerParser().validate(source, {
      resolve: {
        file: false,
        http: false,
        inline: {
          order: 1,
          canRead: (file) => file.url === source,
          read: () => JSON.stringify(document),
        },
      },
      resolveExcludedPathMatcher: excludedPathMatcher,
      dereference: { circular: false, excludedPathMatcher },
    });
  } catch (error) {
    throw new AppError(
      'OPENAPI_DOCUMENT',
      `OpenAPI 文档无效：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
export async function previewOpenApi(input: {
  ownerId: string;
  value: unknown;
  artifacts: ArtifactService;
  fetch: typeof fetch;
}) {
  const options = inputSchema.parse(input.value);
  const origins = new Set(options.referenceOrigins.map((url) => new URL(url).origin));
  if (options.url) origins.add(new URL(options.url).origin);
  const referenceHeaders = new Map(
    Object.entries(options.referenceHeaders).map(([url, headers]) => [
      new URL(url).origin,
      headers,
    ]),
  );
  const read = async (url: string) => {
    if (!origins.has(new URL(httpUrl.parse(url)).origin))
      throw new AppError('OPENAPI_REFERENCE_ORIGIN', '外部引用来源未显式授权');
    const response = await input.fetch(url, {
      redirect: 'error',
      headers:
        url === options.url ? options.documentHeaders : referenceHeaders.get(new URL(url).origin),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new AppError('OPENAPI_DOCUMENT', `读取文档失败：HTTP ${response.status}`, 502);
    return response.text();
  };
  const source = options.url ?? `https://platform-artifact.invalid/${options.artifactId}/openapi`;
  const text = options.url
    ? await read(options.url)
    : await (await input.artifacts.download(input.ownerId, options.artifactId!)).text();
  const parser = new SwaggerParser();
  const excludedPathMatcher = schemaDataMatcher();
  const document = await parser.validate(source, {
    resolve: {
      file: false,
      http: false,
      authorized: {
        order: 1,
        canRead: /^https?:\/\//i,
        read: (file) => (file.url === source ? text : read(file.url)),
      },
    },
    resolveExcludedPathMatcher: excludedPathMatcher,
    dereference: { circular: false, excludedPathMatcher },
  });
  const api = document as unknown as ApiDocument;
  const operations = compileDocument(api);
  return {
    document,
    title: api.info?.title,
    servers: api.servers ?? [],
    schemes: api.components?.securitySchemes ?? {},
    operations,
  };
}
