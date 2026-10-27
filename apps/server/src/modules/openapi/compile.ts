import type { ApiDocument, Operation, Parameter, Schema } from './types.js';
import { AppError } from '../../shared/errors.js';
const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const bodyTypes = new Set([
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
]);

export function compileDocument(document: ApiDocument): Operation[] {
  if (!/^3\.[01]\.\d+$/.test(document.openapi))
    throw new AppError('OPENAPI_VERSION', '仅支持 OpenAPI 3.0/3.1');
  return Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => methods.has(method))
      .map(([method, value]) =>
        compileOperation({
          document,
          path,
          method,
          value: value as Record<string, unknown>,
          shared: item.parameters ?? [],
          servers: (item.servers ?? document.servers ?? []) as { url: string }[],
        }),
      ),
  );
}
function compileOperation(input: {
  document: ApiDocument;
  path: string;
  method: string;
  value: Record<string, unknown>;
  shared: Parameter[];
  servers: { url: string }[];
}): Operation {
  const { document, path, method, value } = input;
  const unique = new Map(input.shared.map((p) => [`${p.in}:${p.name}`, p]));
  for (const p of (value.parameters ?? []) as Parameter[]) unique.set(`${p.in}:${p.name}`, p);
  const parameters = [...unique.values()];
  const unsupported = parameters.flatMap(parameterProblems);
  const body = value.requestBody as
    | { required?: boolean; content?: Operation['content'] }
    | undefined;
  const content = body?.content ?? {};
  for (const type of Object.keys(content))
    if (!bodyTypes.has(type)) unsupported.push(`不支持请求内容类型 ${type}`);
  for (const [type, entry] of Object.entries(content)) {
    if ('encoding' in entry && entry.encoding && Object.keys(entry.encoding).length)
      unsupported.push(`${type}: 暂不支持自定义 encoding`);
  }
  const security = (value.security ?? document.security ?? []) as Operation['security'];
  const schemes = document.components?.securitySchemes ?? {};
  for (const requirement of security) {
    const authorization = Object.keys(requirement).filter(
      (name) =>
        ['http', 'oauth2', 'openIdConnect'].includes(schemes[name]?.type ?? '') ||
        (schemes[name]?.type === 'apiKey' &&
          schemes[name]?.in === 'header' &&
          schemes[name]?.name?.toLowerCase() === 'authorization'),
    );
    if (authorization.length > 1)
      unsupported.push(`AND 认证不能同时写入 Authorization：${authorization.join(', ')}`);
    for (const name of Object.keys(requirement)) {
      const scheme = schemes[name];
      if (!scheme || !['apiKey', 'http', 'oauth2', 'openIdConnect'].includes(scheme.type))
        unsupported.push(`不支持认证方案 ${name}`);
      if (scheme?.type === 'http' && !['basic', 'bearer'].includes(scheme.scheme ?? ''))
        unsupported.push(`不支持 HTTP 认证 ${scheme.scheme}`);
    }
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const location of ['path', 'query', 'header', 'cookie']) {
    const group = parameters.filter((p) => p.in === location);
    if (!group.length) continue;
    properties[location] = {
      type: 'object',
      properties: Object.fromEntries(group.map((p) => [p.name, jsonSchema(p.schema ?? {})])),
      required: group.filter((p) => p.required).map((p) => p.name),
      additionalProperties: false,
    };
    if (group.some((p) => p.required)) required.push(location);
  }
  if (Object.keys(content).length) {
    properties.body = {
      anyOf: Object.values(content).map((entry) => jsonSchema(entry.schema ?? {})),
    };
    properties.mediaType = { type: 'string', enum: Object.keys(content) };
    if (body?.required) required.push('body');
    if (Object.keys(content).length > 1) required.push('mediaType');
  }
  return {
    key: `${method.toUpperCase()} ${path}`,
    name: `${method.toUpperCase()} ${path}`,
    method: method.toUpperCase(),
    path,
    description: [value.summary, value.description].filter(Boolean).join('\n'),
    parameters,
    security,
    schemes,
    content,
    unsupported,
    servers: (value.servers ?? input.servers) as { url: string }[],
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  };
}
function parameterProblems(parameter: Parameter) {
  const problems: string[] = [];
  const schema = parameter.schema;
  if (
    schema &&
    ((schema.type === 'array' && (schema.items as Schema | undefined)?.type === 'object') ||
      (schema.type === 'object' &&
        Object.values((schema.properties ?? {}) as Record<string, Schema>).some((v) =>
          ['array', 'object'].includes(String(v.type)),
        )))
  )
    problems.push(`${parameter.in}.${parameter.name}: 不支持嵌套参数序列化`);
  if (
    parameter.style === 'deepObject' &&
    (schema?.type !== 'object' || parameter.explode === false)
  )
    problems.push(`${parameter.in}.${parameter.name}: deepObject 需要扁平对象和 explode=true`);
  if (
    ['spaceDelimited', 'pipeDelimited'].includes(parameter.style ?? '') &&
    (schema?.type !== 'array' || parameter.explode)
  )
    problems.push(`${parameter.in}.${parameter.name}: 此 style 只支持 explode=false 的标量数组`);
  if (parameter.content)
    problems.push(`${parameter.in}.${parameter.name}: 不支持 content 参数序列化`);
  const allowed: Record<string, string[]> = {
    path: ['simple', 'label', 'matrix'],
    query: ['form', 'spaceDelimited', 'pipeDelimited', 'deepObject'],
    header: ['simple'],
    cookie: ['form'],
  };
  if (
    !allowed[parameter.in]?.includes(
      parameter.style ?? (['query', 'cookie'].includes(parameter.in) ? 'form' : 'simple'),
    )
  )
    problems.push(`${parameter.in}.${parameter.name}: 不支持 style ${parameter.style}`);
  if (parameter.allowReserved)
    problems.push(`${parameter.in}.${parameter.name}: 暂不支持 allowReserved`);
  if (
    parameter.in === 'header' &&
    /^(authorization|host|content-type|cookie|connection|content-length|transfer-encoding)$/i.test(
      parameter.name,
    )
  )
    problems.push(`header.${parameter.name}: 使用认证或内容类型配置`);
  return problems;
}
export function jsonSchema(schema: Schema | boolean): Schema | boolean {
  if (typeof schema === 'boolean') return schema;
  const { nullable, ...rest } = schema;
  const output = Object.fromEntries(
    Object.entries(rest).map(([key, value]) => {
      if (key === 'properties' && value && typeof value === 'object')
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, item]) => [name, jsonSchema(item as Schema)]),
          ),
        ];
      if (['items', 'additionalProperties'].includes(key) && value && typeof value === 'object')
        return [key, jsonSchema(value as Schema)];
      if (['allOf', 'anyOf', 'oneOf'].includes(key) && Array.isArray(value))
        return [key, value.map((item) => jsonSchema(item))];
      return [key, value];
    }),
  );
  return nullable ? { anyOf: [output, { type: 'null' }] } : output;
}
