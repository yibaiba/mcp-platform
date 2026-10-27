import { specTypeSchemas, type StandardSchemaV1Sync } from '@modelcontextprotocol/client';
import { validateToolSchemas, type McpCatalog } from './catalog.js';

function parse<T>(schema: StandardSchemaV1Sync<T>, value: unknown): T {
  const result = schema['~standard'].validate(value);
  if (result.issues) throw new Error(result.issues.map((issue) => issue.message).join('; '));
  return result.value;
}

export function parseCatalog(value: unknown): McpCatalog {
  if (!value || typeof value !== 'object') throw new Error('MCP catalog must be an object');
  const raw = value as Record<string, unknown>;
  const catalog = {
    tools: parse(specTypeSchemas.ListToolsResult, { tools: raw.tools }).tools,
    prompts: parse(specTypeSchemas.ListPromptsResult, { prompts: raw.prompts }).prompts,
    resources: parse(specTypeSchemas.ListResourcesResult, { resources: raw.resources }).resources,
    templates: parse(specTypeSchemas.ListResourceTemplatesResult, {
      resourceTemplates: raw.templates,
    }).resourceTemplates,
    capabilities: parse(specTypeSchemas.ServerCapabilities, raw.capabilities),
    serverInfo: raw.serverInfo ? parse(specTypeSchemas.Implementation, raw.serverInfo) : undefined,
    instructions: typeof raw.instructions === 'string' ? raw.instructions : undefined,
    protocolVersion: typeof raw.protocolVersion === 'string' ? raw.protocolVersion : undefined,
  };
  validateToolSchemas(catalog.tools);
  return catalog;
}
export const parseTool = (value: unknown) => parse(specTypeSchemas.Tool, value);
