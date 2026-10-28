import type { CatalogOptions } from '@platform/contracts';
import { AppError } from '../../shared/errors.js';

export type CatalogTool = {
  id: string;
  connectionId: string;
  name: string;
  definition: Record<string, unknown>;
};
export type ProjectedTool<T extends CatalogTool = CatalogTool> = T & {
  exposedName: string;
  hiddenParameters: readonly string[];
};
const reservedNames = new Set([
  'platform_permissions_catalog',
  'platform_permissions_request',
  'platform_permissions_status',
  'platform_mcp_catalog',
  'platform_mcp_prompt',
  'platform_mcp_resource',
  'platform_artifacts_catalog',
  'platform_artifacts_read',
  'platform_rest_status',
  'platform_rest_result',
  'platform_rest_answer',
  'platform_rest_cancel',
  'platform_tools_search',
  'platform_tools_definition',
  'platform_tools_call',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function hiddenSchema(tool: CatalogTool, hidden: readonly string[]) {
  if (!hidden.length) return tool.definition.inputSchema;
  const schema = record(tool.definition.inputSchema);
  const properties = record(schema?.properties);
  if (!schema || !properties)
    throw new AppError('CATALOG_HIDDEN_PARAMETER', `${tool.name} 没有可配置的顶层参数`);
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const field of hidden) {
    if (!Object.hasOwn(properties, field))
      throw new AppError('CATALOG_HIDDEN_PARAMETER', `${tool.name} 不存在顶层参数 ${field}`);
    if (required.includes(field))
      throw new AppError('CATALOG_REQUIRED_PARAMETER', `${tool.name} 的必填参数 ${field} 不能隐藏`);
  }
  // These constructs can require a property indirectly; do not mislabel it as optional.
  if (
    [
      '$ref',
      'allOf',
      'anyOf',
      'oneOf',
      'if',
      'dependentRequired',
      'dependentSchemas',
      'dependencies',
    ].some((key) => Object.hasOwn(schema, key))
  )
    throw new AppError(
      'CATALOG_COMPLEX_PARAMETERS',
      `${tool.name} 的组合或依赖 Schema 无法确认顶层参数可选性，请使用未隐藏的定义`,
    );
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).filter(([name]) => !hidden.includes(name)),
    ),
  };
}
function exposedName(tool: CatalogTool, config: CatalogOptions) {
  const alias = config.tools[tool.id]?.alias;
  if (alias !== undefined) return alias;
  if (config.toolNaming === 'stable') return tool.id;
  if (config.toolNaming === 'original') return tool.name;
  const prefix = config.connectionAliases[tool.connectionId];
  if (!prefix)
    throw new AppError('CATALOG_CONNECTION_ALIAS', `连接 ${tool.connectionId} 尚未设置展示前缀`);
  return `${prefix}_${tool.name}`;
}
export function projectTools<T extends CatalogTool>(
  tools: readonly T[],
  config: CatalogOptions,
): ProjectedTool<T>[] {
  const names = new Set<string>();
  return tools.map((tool) => {
    const name = exposedName(tool, config);
    if (reservedNames.has(name) || names.has(name))
      throw new AppError('CATALOG_NAME_CONFLICT', `工具展示名冲突：${name}`, 409);
    names.add(name);
    const override = config.tools[tool.id];
    const hiddenParameters = [...new Set(override?.hiddenParameters ?? [])];
    return {
      ...tool,
      exposedName: name,
      hiddenParameters,
      definition: {
        ...tool.definition,
        name,
        inputSchema: hiddenSchema(tool, hiddenParameters),
        ...(override?.description !== undefined ? { description: override.description } : {}),
      },
    };
  });
}
export function assertVisibleArguments(tool: ProjectedTool, args: Record<string, unknown>) {
  const hidden = tool.hiddenParameters.filter((key) => Object.hasOwn(args, key));
  if (hidden.length)
    throw new AppError(
      'HIDDEN_PARAMETER',
      `该 Profile 禁止传入隐藏参数：${hidden.join(', ')}`,
      400,
    );
}
export function projectContent<T extends { id: string; definition: Record<string, unknown> }>(
  entries: readonly T[],
  config: CatalogOptions,
): T[] {
  return entries.map((entry) => {
    const description = config.content[entry.id]?.description;
    return description === undefined
      ? entry
      : { ...entry, definition: { ...entry.definition, description } };
  });
}
