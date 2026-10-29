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
  const request = (path: string, method = 'GET', data?: unknown) =>
    client.request({ path, method, body: data });
  if (group === 'whoami' && !action) return request('/api/v1/me');
  if (group === 'connections') {
    if (action === 'list') return request('/api/v1/connections');
    if (action === 'get') return request(`/api/v1/connections/${id(target)}`);
    if (action === 'add') return request('/api/v1/connections', 'POST', body);
    if (action === 'update') return request(`/api/v1/connections/${id(target)}`, 'PATCH', body);
    if (action === 'connect' || action === 'stop')
      return request(
        `/api/v1/connections/${id(target)}/${action === 'connect' ? 'discover' : 'stop'}`,
        'POST',
      );
  }
  if (group === 'profiles' && action === 'list') return request('/api/v1/profiles');
  if (group === 'profiles' && action === 'get') return request(`/api/v1/profiles/${id(target)}`);
  if (group === 'keys') {
    if (action === 'list') return request('/api/v1/profiles/keys/all');
    if (action === 'create') return request(`/api/v1/profiles/${id(target)}/keys`, 'POST');
    if (action === 'revoke') return request(`/api/v1/profiles/keys/${id(target)}`, 'DELETE');
  }
  if (group === 'config') {
    if (action === 'preview' || action === 'apply')
      return request(`/api/v1/config/manifests/${action}`, 'POST', body);
    if (action === 'status')
      return request(`/api/v1/config/manifests${target ? `/${id(target)}` : ''}`);
    if (action === 'export')
      return request(`/api/v1/config/export?name=${encodeURIComponent(target ?? 'platform')}`);
  }
  if (group === 'tools' || group === 'calls')
    return businessCommand({ group, action, target, values, client, body });
  throw new CliError('未知命令；使用 --help 查看用法', 2);
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
