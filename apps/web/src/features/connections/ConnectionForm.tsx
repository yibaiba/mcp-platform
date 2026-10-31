import { Disclosure } from '../../components/shared/Disclosure.js';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { SelectItem } from '../../components/ui/select.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { Field, Form, value } from '../../components/shared/Controls.js';
import { api, json, type Device } from '../../lib/api.js';
import { useMe } from '../../lib/me.js';
import { parseArgumentLines } from '@platform/contracts';
import { parseJsonObject } from './jsonField.js';
import { ArgumentsField } from './ArgumentsField.js';
import { connectNow, type ConnectOutcome } from './connectNow.js';
import { ToolPrefixField } from './ToolPrefixField.js';

const idOf = (value: unknown) =>
  value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
    ? value.id
    : undefined;

export function ConnectionForm({
  devices,
  onSaved,
  onConnected,
  initialDeviceId,
  save,
}: {
  devices: Device[];
  onSaved?: (result: unknown) => void;
  /** Set to save and connect in one step; the outcome says whether connecting worked. */
  onConnected?: (outcome: ConnectOutcome) => void;
  initialDeviceId?: string;
  save?: (config: Record<string, unknown>) => Promise<unknown>;
}) {
  const [adapter, setAdapter] = useState(initialDeviceId ? 'device' : 'direct');
  const [transport, setTransport] = useState(initialDeviceId ? 'stdio' : 'http');
  const [mode, setMode] = useState('existing');
  // What the tool-prefix suggestion is based on, kept in sync while the user types.
  const [draft, setDraft] = useState({ name: '', url: '', command: '', args: '' });
  // Platform-host stdio is admin-only behind PLATFORM_STDIO_ENABLED; the server enforces it too.
  const me = useMe().data;
  const hostStdio = Boolean(me?.hostStdio);
  const stdioAllowed = adapter === 'device' || hostStdio;
  const activeDevices = devices.filter((device) => !device.revoked);
  const needsCommand = transport === 'stdio' || (adapter === 'device' && mode === 'managed');
  async function submit(data: FormData) {
    const extra = parseJsonObject(value(data, 'advanced'), '高级配置');
    const config = {
      ...extra,
      name: value(data, 'name'),
      toolPrefix: value(data, 'toolPrefix') || undefined,
      adapter,
      transport,
      mode: transport === 'stdio' ? 'managed' : mode,
      deviceId: adapter === 'device' ? value(data, 'deviceId') : undefined,
      url: transport !== 'stdio' ? value(data, 'url') : undefined,
      command: needsCommand ? value(data, 'command') || undefined : undefined,
      args: needsCommand ? parseArgumentLines(value(data, 'args')) : [],
    };
    const created = save
      ? await save(config)
      : await api('/connections', { method: 'POST', body: json(config) });
    onSaved?.(created);
    const id = idOf(created);
    if (onConnected && id) onConnected(await connectNow(id));
  }
  return (
    <Form label={onConnected ? '保存并连接' : '保存连接'} submit={submit}>
      <div
        className="form-grid"
        onChange={(event) => {
          const target = event.target as HTMLInputElement;
          if (target.name in draft) setDraft((old) => ({ ...old, [target.name]: target.value }));
        }}
      >
        <Field label="连接名称">
          <Input name="name" placeholder="例如：文档搜索" required />
        </Field>
        {initialDeviceId ? null : (
          <Field label="运行位置">
            <SelectControl
              value={adapter}
              onValueChange={(next) => {
                setAdapter(next);
                setTransport(next === 'device' ? 'stdio' : 'http');
                setMode('existing');
              }}
            >
              <SelectItem value="direct">平台服务器</SelectItem>
              <SelectItem value="device">我的设备（设备连接器）</SelectItem>
              <SelectItem value="pi">Pi 桥接（高级，无需模型）</SelectItem>
            </SelectControl>
          </Field>
        )}
        {adapter === 'device' ? (
          activeDevices.length ? (
            <Field label="运行在哪台设备">
              <SelectControl
                name="deviceId"
                defaultValue={initialDeviceId ?? activeDevices[0]?.id}
                required
              >
                {activeDevices.map((device) => (
                  <SelectItem value={device.id} key={device.id}>
                    {device.name} · {device.online ? '在线' : '离线'}
                  </SelectItem>
                ))}
              </SelectControl>
            </Field>
          ) : (
            <p role="status" className="attention text-sm">
              还没有设备 · <Link to="/devices">添加设备</Link>
              ：在要运行命令的电脑上装好连接器后再回来。
            </p>
          )
        ) : null}
        {adapter === 'device' ? (
          <Field label="连接方式">
            <SelectControl
              value={transport === 'stdio' ? 'stdio' : mode === 'managed' ? 'managed' : 'existing'}
              onValueChange={(next) => {
                setTransport(next === 'stdio' ? 'stdio' : 'http');
                setMode(next === 'managed' ? 'managed' : 'existing');
              }}
            >
              <SelectItem value="stdio">运行本地命令（stdio）</SelectItem>
              <SelectItem value="existing">连接这台电脑上已有的 HTTP 服务</SelectItem>
              <SelectItem value="managed">启动命令并连接它提供的 HTTP 服务</SelectItem>
            </SelectControl>
          </Field>
        ) : (
          <Field
            label="连接方式"
            hint={'远程地址：服务已在网上运行；本地命令：由平台启动一个进程。'}
          >
            <SelectControl value={transport} onValueChange={setTransport}>
              <SelectItem value="http">远程地址（Streamable HTTP）</SelectItem>
              <SelectItem value="sse">远程地址（HTTP + SSE，旧版）</SelectItem>
              {stdioAllowed ? <SelectItem value="stdio">本地命令（stdio）</SelectItem> : null}
            </SelectControl>
          </Field>
        )}
        {transport !== 'stdio' ? (
          <Field
            label="MCP 地址"
            hint={
              adapter === 'device'
                ? '从那台电脑访问的地址，例如 http://127.0.0.1:3000/mcp'
                : undefined
            }
          >
            <Input name="url" type="url" placeholder="https://mcp.example.com/mcp" required />
          </Field>
        ) : null}
        {needsCommand ? (
          <>
            <Field
              label="启动命令"
              hint={
                adapter === 'device'
                  ? '命令在所选设备上运行；该设备必须已安装程序。'
                  : '命令在平台服务器上运行；Docker 部署时在 server 容器内运行，程序需预先安装。'
              }
            >
              <Input name="command" placeholder="npx / uvx / 可执行文件路径" required />
            </Field>
            {adapter !== 'device' && transport === 'stdio' ? (
              <SandboxNote sandbox={me?.stdioSandbox} />
            ) : null}
            <ArgumentsField />
          </>
        ) : null}
      </div>
      <ToolPrefixField
        source={{
          name: draft.name,
          url: transport !== 'stdio' ? draft.url : undefined,
          command: needsCommand ? draft.command : undefined,
          args: needsCommand ? parseArgumentLines(draft.args) : undefined,
        }}
      />
      <Disclosure
        title={
          transport === 'stdio'
            ? '高级：环境变量与工作目录（JSON）'
            : '高级：请求头、环境变量与预注册 OAuth 客户端（JSON）'
        }
      >
        <Field
          label="高级配置（JSON）"
          hint={
            transport === 'stdio'
              ? '可选。使用 env 配置进程凭证，cwd 指定执行目录；凭证加密存储'
              : '可选。支持 headers、env、cwd、oauth；凭证加密存储'
          }
        >
          <Textarea name="advanced" defaultValue={'{\n  "headers": {},\n  "env": {}\n}'} rows={5} />
        </Field>
      </Disclosure>
    </Form>
  );
}

/** Where a platform-host stdio command will run: unsandboxed, in bubblewrap, or refused. */
function SandboxNote({
  sandbox,
}: {
  sandbox?: NonNullable<ReturnType<typeof useMe>['data']>['stdioSandbox'];
}) {
  if (!sandbox) return null;
  if (sandbox.mode === 'off')
    return (
      <p className="text-sm text-muted-foreground" data-testid="stdio-sandbox">
        未启用沙箱（STDIO_SANDBOX=off）：命令以平台服务进程的权限运行，能读写服务能访问的文件。部署时可以开启
        bubblewrap 沙箱，见部署文档「stdio 沙箱」。
      </p>
    );
  if (sandbox.ready)
    return (
      <p className="text-sm text-muted-foreground" data-testid="stdio-sandbox">
        在 bubblewrap {sandbox.version} 沙箱里运行：根目录只读，看不到平台数据目录和密钥，HOME
        是这个连接私有的目录；网络照常。
      </p>
    );
  return (
    <p
      role="alert"
      data-testid="stdio-sandbox"
      className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive"
    >
      已开启 stdio 沙箱，但现在不可用：{sandbox.error}。{sandbox.hint}
      。这类连接不会启动，也不会在沙箱外运行。
    </p>
  );
}
