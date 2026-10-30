import { Disclosure } from '../../components/shared/Disclosure.js';
import { useState } from 'react';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { SelectItem } from '../../components/ui/select.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { Field, Form, value } from '../../components/shared/Controls.js';
import { api, json, type Device } from '../../lib/api.js';
import { useMe } from '../../lib/me.js';

export function ConnectionForm({
  devices,
  onSaved,
  initialDeviceId,
  save,
}: {
  devices: Device[];
  onSaved: (result: unknown) => void;
  initialDeviceId?: string;
  save?: (config: Record<string, unknown>) => Promise<unknown>;
}) {
  const [adapter, setAdapter] = useState(initialDeviceId ? 'device' : 'direct');
  const [transport, setTransport] = useState(initialDeviceId ? 'stdio' : 'http');
  // Platform-host stdio is admin-only behind PLATFORM_STDIO_ENABLED; the server enforces it too.
  const hostStdio = Boolean(useMe().data?.hostStdio);
  const stdioAllowed = adapter === 'device' || hostStdio;
  async function submit(data: FormData) {
    const extra = JSON.parse(value(data, 'advanced') || '{}') as Record<string, unknown>;
    const config = {
      ...extra,
      name: value(data, 'name'),
      adapter,
      transport,
      mode: transport === 'stdio' ? 'managed' : value(data, 'mode'),
      deviceId: adapter === 'device' ? value(data, 'deviceId') : undefined,
      url: transport !== 'stdio' ? value(data, 'url') : undefined,
      command: value(data, 'command') || undefined,
      args: JSON.parse(value(data, 'args') || '[]'),
    };
    const created = save
      ? await save(config)
      : await api('/connections', { method: 'POST', body: json(config) });
    onSaved(created);
  }
  return (
    <Form label="保存连接" submit={submit}>
      <div className="form-grid">
        <Field label="连接名称">
          <Input name="name" placeholder="例如：文档搜索" required />
        </Field>
        <Field label="执行适配器">
          <SelectControl
            value={adapter}
            onValueChange={(value) => {
              setAdapter(value);
              setTransport('http');
            }}
          >
            <SelectItem value="direct">平台直连</SelectItem>
            <SelectItem value="device">设备连接器</SelectItem>
            <SelectItem value="pi">Pi 桥接（无需模型）</SelectItem>
          </SelectControl>
        </Field>
        {adapter === 'device' ? (
          <Field label="执行设备">
            <SelectControl name="deviceId" defaultValue={initialDeviceId} required>
              {devices
                .filter((device) => !device.revoked)
                .map((device) => (
                  <SelectItem value={device.id} key={device.id}>
                    {device.name} · {device.online ? '在线' : '离线'}
                  </SelectItem>
                ))}
            </SelectControl>
          </Field>
        ) : null}
        <Field label="传输协议" hint={'远程服务支持 HTTP/HTTPS；本地进程使用 stdio。'}>
          <SelectControl value={transport} onValueChange={setTransport}>
            <SelectItem value="http">Streamable HTTP</SelectItem>
            <SelectItem value="sse">HTTP + SSE（旧版兼容）</SelectItem>
            {stdioAllowed ? <SelectItem value="stdio">stdio（本地进程）</SelectItem> : null}
          </SelectControl>
        </Field>
        {transport !== 'stdio' ? (
          <>
            <Field label="MCP 地址">
              <Input name="url" type="url" placeholder="https://mcp.example.com/mcp" required />
            </Field>
            <Field label="进程模式">
              <SelectControl name="mode" defaultValue="existing">
                <SelectItem value="existing">连接已有服务</SelectItem>
                {adapter === 'device' ? (
                  <SelectItem value="managed">托管启动 HTTP 服务</SelectItem>
                ) : null}
              </SelectControl>
            </Field>
          </>
        ) : null}
        {adapter === 'device' || transport === 'stdio' ? (
          <>
            <Field
              label="启动命令"
              hint={
                adapter === 'device'
                  ? '命令在所选设备上运行；该设备必须已安装程序。'
                  : '命令在平台主机上运行；Docker 部署时在 server 容器内运行，程序需预先安装。'
              }
            >
              <Input
                name="command"
                placeholder="npx / uvx / 可执行文件路径"
                required={transport === 'stdio'}
              />
            </Field>
            <Field label="参数（JSON 数组）">
              <Input name="args" defaultValue="[]" />
            </Field>
          </>
        ) : null}
      </div>
      <Disclosure
        title={
          transport === 'stdio' ? '环境变量与工作目录' : '请求头、环境变量与预注册 OAuth 客户端'
        }
      >
        <Field
          label="高级配置（JSON）"
          hint={
            transport === 'stdio'
              ? '使用 env 配置进程凭证，cwd 指定执行目录；凭证加密存储'
              : '支持 headers、env、cwd、oauth；凭证加密存储'
          }
        >
          <Textarea name="advanced" defaultValue={'{\n  "headers": {},\n  "env": {}\n}'} rows={5} />
        </Field>
      </Disclosure>
    </Form>
  );
}
