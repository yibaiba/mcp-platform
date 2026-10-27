import type {
  Client,
  Tool,
  Prompt,
  Resource,
  ResourceTemplateType,
} from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';

export type McpCatalog = {
  tools: Tool[];
  prompts: Prompt[];
  resources: Resource[];
  templates: ResourceTemplateType[];
  protocolVersion?: string;
  serverInfo?: Record<string, unknown>;
  instructions?: string;
  capabilities: Record<string, unknown>;
};
const validator = new AjvJsonSchemaValidator();
export class McpValidationError extends Error {
  readonly code = 'MCP_SCHEMA_VALIDATION';
}

export function validateToolSchemas(tools: Tool[]) {
  for (const tool of tools) {
    for (const [field, schema] of Object.entries({
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    })) {
      if (!schema) continue;
      try {
        validator.getValidator(schema as Parameters<typeof validator.getValidator>[0]);
      } catch (error) {
        throw new Error(
          `工具 ${tool.name} 的 ${field} 无法编译：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

export function validateToolValue(input: {
  tool: Tool;
  value: unknown;
  field: 'inputSchema' | 'outputSchema';
}) {
  const schema = input.tool[input.field];
  if (!schema) return;
  const result = validator.getValidator(schema as Parameters<typeof validator.getValidator>[0])(
    input.value,
  );
  if (!result.valid)
    throw new McpValidationError(
      `工具 ${input.tool.name} 的 ${input.field} 校验失败：${result.errorMessage}`,
    );
}

async function pages<T>(
  fetch: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
) {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetch(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

export async function discoverCatalog(client: Client, signal?: AbortSignal): Promise<McpCatalog> {
  const capabilities = client.getServerCapabilities() ?? {};
  const options = { signal, cacheMode: 'refresh' as const };
  const [tools, prompts, resources, templates] = await Promise.all([
    capabilities.tools
      ? pages(async (cursor) => {
          const r = await client.listTools({ cursor }, options);
          return { items: r.tools, nextCursor: r.nextCursor };
        })
      : [],
    capabilities.prompts
      ? pages(async (cursor) => {
          const r = await client.listPrompts({ cursor }, options);
          return { items: r.prompts, nextCursor: r.nextCursor };
        })
      : [],
    capabilities.resources
      ? pages(async (cursor) => {
          const r = await client.listResources({ cursor }, options);
          return { items: r.resources, nextCursor: r.nextCursor };
        })
      : [],
    capabilities.resources
      ? pages(async (cursor) => {
          const r = await client.listResourceTemplates({ cursor }, options);
          return { items: r.resourceTemplates, nextCursor: r.nextCursor };
        })
      : [],
  ]);
  validateToolSchemas(tools);
  return {
    tools,
    prompts,
    resources,
    templates,
    capabilities,
    serverInfo: client.getServerVersion(),
    instructions: client.getInstructions(),
    protocolVersion: client.getNegotiatedProtocolVersion(),
  };
}
