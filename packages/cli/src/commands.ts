import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CliError } from './errors.js';
import type { HttpClient } from './httpClient.js';
export function parseCommand(args: string[]) {
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean' },
        env: { type: 'string' },
        profile: { type: 'string' },
        file: { type: 'string' },
        data: { type: 'string' },
        'idempotency-key': { type: 'string' },
        'read-only': { type: 'boolean' },
        'no-browser': { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : '参数无效', 2);
  }
}
export type Command = ReturnType<typeof parseCommand>;
export const help = `MCP Platform CLI
login [--read-only] [--no-browser] | logout | whoami
env add <name> <url> | env use <name> | env list
connections list|get <id>|add|update <id>|connect <id>|stop <id>
profiles list|get <id> | keys list|create <profile-id>|revoke <key-id>
tools list|describe <tool-id>|call <tool-id> --profile <id>
calls status|result|answer|cancel <call-id> --profile <id>
config preview|apply|status [name]|export [name]
--file <JSON file> or --data <JSON> for request bodies; --json; --env <name>
Business commands require MCP_PLATFORM_AGENT_TOKEN; management token can be injected via MCP_PLATFORM_ACCESS_TOKEN.
No mutation or business call is retried. Build/run from repository: pnpm cli --help`;
const id = (value?: string) => {
  if (!value) throw new CliError('缺少资源 ID', 2);
  return encodeURIComponent(value);
};
type ManagementCommand = {
  method?: string;
  path: (target?: string) => string;
  target?: 'required' | 'optional';
  body?: boolean;
};
const managementCommands: Record<string, ManagementCommand> = {
  whoami: { path: () => '/api/v1/me' },
  'connections:list': { path: () => '/api/v1/connections' },
  'connections:get': { target: 'required', path: (target) => `/api/v1/connections/${id(target)}` },
  'connections:add': { method: 'POST', body: true, path: () => '/api/v1/connections' },
  'connections:update': {
    method: 'PATCH',
    target: 'required',
    body: true,
    path: (target) => `/api/v1/connections/${id(target)}`,
  },
  'connections:connect': {
    method: 'POST',
    target: 'required',
    path: (target) => `/api/v1/connections/${id(target)}/discover`,
  },
  'connections:stop': {
    method: 'POST',
    target: 'required',
    path: (target) => `/api/v1/connections/${id(target)}/stop`,
  },
  'profiles:list': { path: () => '/api/v1/profiles' },
  'profiles:get': { target: 'required', path: (target) => `/api/v1/profiles/${id(target)}` },
  'keys:list': { path: () => '/api/v1/profiles/keys/all' },
  'keys:create': {
    method: 'POST',
    target: 'required',
    path: (target) => `/api/v1/profiles/${id(target)}/keys`,
  },
  'keys:revoke': {
    method: 'DELETE',
    target: 'required',
    path: (target) => `/api/v1/profiles/keys/${id(target)}`,
  },
  'config:preview': { method: 'POST', body: true, path: () => '/api/v1/config/manifests/preview' },
  'config:apply': { method: 'POST', body: true, path: () => '/api/v1/config/manifests/apply' },
  'config:status': {
    target: 'optional',
    path: (target) => `/api/v1/config/manifests${target ? `/${id(target)}` : ''}`,
  },
  'config:export': {
    target: 'optional',
    path: (target) => `/api/v1/config/export?name=${encodeURIComponent(target ?? 'platform')}`,
  },
};
export async function remoteCommand(input: {
  command: Command;
  client: HttpClient;
  body: unknown;
}) {
  const {
    command: {
      positionals: [group, action, target, ...extra],
      values,
    },
    client,
    body,
  } = input;
  if (extra.length) throw new CliError('位置参数过多', 2);
  if (group === 'tools' || group === 'calls')
    return businessCommand({ group, action, target, values, client, body });
  const name = action ? `${group}:${action}` : group;
  const route = name ? managementCommands[name] : undefined;
  if (!route) throw new CliError('未知命令；使用 --help 查看用法', 2);
  if (target && !route.target) throw new CliError('该命令不接受资源 ID', 2);
  if (route.body && body === undefined)
    throw new CliError('该命令需要 --file 或 --data JSON 请求体', 2);
  const result = await client.request({
    path: route.path(target),
    method: route.method,
    body: route.body ? body : undefined,
  });
  return name === 'keys:create'
    ? { ...result, body: z.object({ id: z.string(), token: z.string() }).parse(result.body) }
    : result;
}
async function businessCommand(input: {
  group: string;
  action?: string;
  target?: string;
  values: Command['values'];
  client: HttpClient;
  body: unknown;
}) {
  const { group, action, target, values, client, body } = input;
  if (!values.profile || !z.uuid().safeParse(values.profile).success)
    throw new CliError('业务命令需要 --profile <Profile UUID>', 2);
  const root = `/mcp/${encodeURIComponent(values.profile)}/rest`;
  if (group === 'tools' && action === 'list')
    return client.request({ path: `${root}/tools`, agent: true });
  if (group === 'tools' && action === 'describe')
    return client.request({ path: `${root}/tools/${id(target)}`, agent: true });
  if (group === 'tools' && action === 'call')
    return client.request({
      path: `${root}/tools/${id(target)}`,
      method: 'POST',
      body: body ?? {},
      agent: true,
      idempotencyKey: values['idempotency-key'],
    });
  if (group === 'calls' && ['status', 'result', 'answer', 'cancel'].includes(action ?? ''))
    return client.request({
      path: `${root}/calls/${id(target)}${action === 'status' ? '' : `/${action}`}`,
      method: action === 'answer' || action === 'cancel' ? 'POST' : 'GET',
      body: action === 'answer' ? body : undefined,
      agent: true,
    });
  throw new CliError('未知业务命令', 2);
}
