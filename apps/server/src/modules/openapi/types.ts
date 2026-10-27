export type Schema = Record<string, unknown>;
export type Parameter = {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
  schema?: Schema;
  content?: unknown;
};
export type SecurityRequirement = Record<string, string[]>;
export type SecurityScheme = {
  type: string;
  name?: string;
  in?: string;
  scheme?: string;
  flows?: Record<string, unknown>;
  openIdConnectUrl?: string;
};
export type Operation = {
  key: string;
  method: string;
  path: string;
  name: string;
  description?: string;
  parameters: Parameter[];
  inputSchema: Schema;
  security: SecurityRequirement[];
  schemes: Record<string, SecurityScheme>;
  content: Record<string, { schema?: Schema }>;
  unsupported: string[];
  servers: { url: string }[];
};
export type ApiDocument = {
  openapi: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: { url: string }[];
  security?: SecurityRequirement[];
  components?: { securitySchemes?: Record<string, SecurityScheme> };
  paths?: Record<string, Record<string, unknown> & { parameters?: Parameter[] }>;
};
