#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ConfigStore, configDirectory, platformUrl } from './configStore.js';
import { HttpClient } from './httpClient.js';
import { parseCommand, remoteCommand, help } from './commands.js';
import { login } from './login.js';
import { CliError } from './errors.js';
const diagnostic = (message: string) => process.stderr.write(`${message}\n`);
async function openBrowser(url: string) {
  const command =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url]
        : ['xdg-open', url];
  try {
    await promisify(execFile)(command[0]!, command.slice(1));
  } catch {
    throw new CliError('无法启动浏览器；请使用 login --no-browser 后手动打开终端所示地址', 4);
  }
}
async function main() {
  const command = parseCommand(process.argv.slice(2));
  if (command.values.help) {
    process.stdout.write(`${command.values.json ? JSON.stringify({ help }) : help}\n`);
    return;
  }
  const store = new ConfigStore(configDirectory(process.env));
  const client = new HttpClient({
    fetch,
    store,
    env: process.env,
    environment: command.values.env,
  });
  const [group, action, name, url] = command.positionals;
  let output: unknown;
  if (group === 'env') output = await environmentCommand({ store, action, name, url });
  else if (group === 'login') {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    process.once('SIGINT', cancel);
    try {
      output = await login({
        client,
        readOnly: command.values['read-only'] ?? false,
        signal: abort.signal,
        diagnostic,
        open: command.values['no-browser'] ? async () => {} : openBrowser,
      });
    } finally {
      process.removeListener('SIGINT', cancel);
    }
  } else if (group === 'logout') {
    await client.request({ path: '/api/v1/cli/logout', method: 'POST' });
    const { config, name, environment } = await client.environment();
    await store.write({
      ...config,
      environments: { ...config.environments, [name]: { url: environment.url } },
    });
    output = { revoked: true, environment: name };
  } else {
    if (command.values.file && command.values.data)
      throw new CliError('--file 和 --data 只能选一个', 2);
    const raw = command.values.file
      ? await readFile(command.values.file, 'utf8')
      : command.values.data;
    let body: unknown;
    try {
      body = raw === undefined ? undefined : JSON.parse(raw);
    } catch {
      throw new CliError('请求体不是有效 JSON', 2);
    }
    const result = await remoteCommand({ command, client, body });
    output = result.body;
    if (result.callId) diagnostic(`调用 ID：${result.callId}`);
    const record = z
      .object({
        isError: z.boolean().optional(),
        status: z.string().optional(),
        callId: z.string().optional(),
      })
      .passthrough()
      .safeParse(output);
    if (record.success && (record.data.isError || record.data.status === 'tool_error'))
      process.exitCode = 5;
    if (record.success && record.data.status === 'waiting')
      diagnostic(
        `等待交互；使用 calls answer ${record.data.callId} --profile ${command.values.profile} --file <回答.json>，不会自动重放`,
      );
  }
  process.stdout.write(`${JSON.stringify(output, null, command.values.json ? undefined : 2)}\n`);
}
async function environmentCommand(input: {
  store: ConfigStore;
  action?: string;
  name?: string;
  url?: string;
}) {
  const { store, action, name, url } = input,
    config = await store.read();
  if (action === 'list')
    return {
      current: config.current,
      environments: Object.fromEntries(
        Object.entries(config.environments).map(([key, value]) => [
          key,
          { url: value.url, loggedIn: Boolean(value.credentials) },
        ]),
      ),
    };
  if (!name) throw new CliError('缺少环境名称', 2);
  if (action === 'add') {
    if (config.environments[name])
      throw new CliError('该环境已存在；请选择新名称，避免覆盖已有授权', 2);
    const parsed = platformUrl.safeParse(url);
    if (!parsed.success) throw new CliError('无效的平台 HTTP(S) 地址', 2);
    await store.write({
      ...config,
      current: config.current ?? name,
      environments: { ...config.environments, [name]: { url: parsed.data } },
    });
    return { environment: name, url: parsed.data };
  }
  if (action === 'use' && config.environments[name]) {
    await store.write({ ...config, current: name });
    return { current: name };
  }
  throw new CliError('未知环境或环境命令', 2);
}
void main().catch((error: unknown) => {
  const known = error instanceof CliError;
  diagnostic(
    known
      ? error.message
      : error instanceof z.ZodError
        ? '服务响应或本地配置格式无效'
        : 'CLI 操作失败；请检查文件权限、平台连接和配置',
  );
  process.exitCode = known ? error.exitCode : 4;
});
