import type { ConnectionAdapter, ConnectionContext } from '../mcp/adapter.js';
import type { ArtifactService } from '../artifacts/artifactService.js';
import type { ApiOAuthService } from './oauthService.js';
import type { ApiDocument, Operation } from './types.js';
import { compileDocument, jsonSchema } from './compile.js';
import { serializeParameter } from './serialization.js';
import { applySecurity } from './security.js';
import { AppError } from '../../shared/errors.js';
import { validateToolValue, parseTool } from '@platform/mcp';

export function createOpenApiAdapter(
  context: ConnectionContext,
  deps: {
    fetch: typeof fetch;
    artifacts: ArtifactService;
    oauth: ApiOAuthService;
    authorizeArtifact: (id: string) => Promise<void>;
  },
): ConnectionAdapter {
  const config = context.config.openapi!;
  const document = config.document as unknown as ApiDocument;
  const operations = compileDocument(document).filter((operation) =>
    config.operations.includes(operation.key),
  );
  if (
    operations.length !== config.operations.length ||
    operations.some((op) => op.unsupported.length)
  )
    throw new AppError('OPENAPI_OPERATIONS', '发布操作不存在或包含预览中标记的不支持项');
  const tools = operations.map((op) =>
    parseTool({ name: op.name, description: op.description, inputSchema: op.inputSchema }),
  );
  const lifetime = new AbortController();
  return {
    status: () => (lifetime.signal.aborted ? 'disconnected' : 'connected'),
    watch: () => () => {},
    catalog: async () => ({
      tools,
      prompts: [],
      resources: [],
      templates: [],
      capabilities: { tools: {} },
      serverInfo: {
        name: document.info?.title ?? context.config.name,
        version: document.info?.version ?? '',
      },
      instructions: document.info?.description,
    }),
    discover: async () => tools,
    request: async () => {
      throw new AppError('OPENAPI_OPERATION', 'OpenAPI 来源仅提供已发布工具');
    },
    call: async (input) => {
      const operation = operations.find((op) => op.name === input.name);
      if (!operation) throw new AppError('TOOL_NOT_FOUND', '操作不存在', 404);
      validateToolValue({
        tool: tools.find((t) => t.name === input.name)!,
        field: 'inputSchema',
        value: input.arguments,
      });
      const signal = AbortSignal.any([lifetime.signal, ...(input.signal ? [input.signal] : [])]);
      const { url, headers } = buildRequest(config.baseUrl, operation, input.arguments);
      await applySecurity({
        operation,
        choice: config.securityChoices[operation.key],
        credentials: config.credentials,
        url,
        headers,
        token: (name, scopes) => deps.oauth.token(context, name, scopes),
      });
      const body = await requestBody({
        operation,
        args: input.arguments,
        headers,
        artifact: async (id) => {
          await deps.authorizeArtifact(id);
          return deps.artifacts.blob(context.ownerId, id);
        },
      });
      const response = await deps.fetch(url, {
        method: operation.method,
        headers,
        body,
        signal,
        redirect: 'error',
      });
      if (!response.ok)
        throw new AppError('OPENAPI_HTTP', `${operation.key} 返回 HTTP ${response.status}`, 502);
      const type = response.headers.get('content-type') ?? '';
      if (type.includes('application/json') || type.includes('+json')) {
        const result: unknown = await response.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: { response: result, status: response.status },
        };
      }
      if (type.startsWith('text/') || !response.body)
        return { content: [{ type: 'text', text: await response.text() }] };
      const artifact = await deps.artifacts.store(context.ownerId, {
        name: `${context.config.name}-response`,
        body: response.body,
      });
      return {
        content: [{ type: 'text', text: `产物 ${artifact.id}` }],
        structuredContent: {
          artifactId: artifact.id,
          size: artifact.size,
          sha256: artifact.sha256,
        },
      };
    },
    close: async () => {
      lifetime.abort(new Error('OpenAPI 连接已关闭'));
    },
  };
}
function buildRequest(baseUrl: string, operation: Operation, args: Record<string, unknown>) {
  let path = operation.path;
  const headers = new Headers();
  const query: [string, string][] = [];
  for (const parameter of operation.parameters) {
    const group = args[parameter.in] as Record<string, unknown> | undefined;
    if (group?.[parameter.name] === undefined) continue;
    const pairs = serializeParameter(parameter, group[parameter.name]);
    if (parameter.in === 'path' && ['.', '..'].includes(pairs[0]![1]))
      throw new AppError('OPENAPI_PATH', '路径参数不能是目录跳转段');
    if (parameter.in === 'path') path = path.replaceAll(`{${parameter.name}}`, pairs[0]![1]);
    if (parameter.in === 'query') query.push(...pairs);
    if (parameter.in === 'header')
      headers.set(parameter.name, pairs.map(([, value]) => value).join(','));
    if (parameter.in === 'cookie')
      headers.set(
        'Cookie',
        [
          headers.get('Cookie'),
          pairs
            .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
            .join('; '),
        ]
          .filter(Boolean)
          .join('; '),
      );
  }
  const base = new URL(baseUrl);
  base.pathname = base.pathname.replace(/\/$/, '') + path;
  for (const [key, value] of query) base.searchParams.append(key, value);
  return { url: base, headers };
}
async function requestBody(input: {
  operation: Operation;
  args: Record<string, unknown>;
  headers: Headers;
  artifact: (id: string) => Promise<Blob>;
}) {
  if (input.args.body === undefined) return undefined;
  const mediaType = String(input.args.mediaType ?? Object.keys(input.operation.content)[0]);
  if (!input.operation.content[mediaType])
    throw new AppError('OPENAPI_CONTENT_TYPE', '请求内容类型未在操作中声明');
  validateToolValue({
    tool: parseTool({
      name: input.operation.name,
      inputSchema: jsonSchema(input.operation.content[mediaType]?.schema ?? {}),
    }),
    field: 'inputSchema',
    value: input.args.body,
  });
  if (mediaType === 'application/json') {
    input.headers.set('Content-Type', mediaType);
    return JSON.stringify(input.args.body);
  }
  if (mediaType === 'application/x-www-form-urlencoded') {
    input.headers.set('Content-Type', mediaType);
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(input.args.body as Record<string, unknown>)) {
      for (const [name, item] of serializeParameter({ name: key, in: 'query' }, value))
        body.append(name, item);
    }
    return body;
  }
  const body = new FormData();
  const properties = input.operation.content[mediaType]?.schema?.properties as
    | Record<string, { format?: string; type?: string; items?: { format?: string } }>
    | undefined;
  for (const [key, value] of Object.entries(input.args.body as Record<string, unknown>)) {
    if (properties?.[key]?.format === 'binary') {
      const blob = await input.artifact(String(value));
      body.append(key, blob, key);
    } else if (properties?.[key]?.type === 'array' && Array.isArray(value)) {
      for (const item of value)
        body.append(
          key,
          properties[key]?.items?.format === 'binary'
            ? await input.artifact(String(item))
            : typeof item === 'object'
              ? JSON.stringify(item)
              : String(item),
        );
    } else body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return body;
}
