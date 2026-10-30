import { useState } from 'react';
import type { SshAccessView, SshAccessInput } from '@platform/contracts';
import { Field, Form, value } from '../../components/shared/Controls.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { SelectItem } from '../../components/ui/select.js';
import { api, json, type Connection } from '../../lib/api.js';
export function SshAccessForm({
  current: initial,
  connections,
  done,
}: {
  current?: SshAccessView;
  connections: Connection[];
  done: () => void;
}) {
  // Keep the revision paired with this editor's initial values during background refresh.
  const [current] = useState(initial);
  const [bindings, setBindings] = useState<SshAccessInput['bindings']>(
    current?.bindings ?? [{ connectionId: '', localPort: 3000, remotePort: 13000 }],
  );
  return (
    <Form
      label={current ? '保存 SSH 接入' : '添加 SSH 接入'}
      submit={async (data) => {
        await api(`/ssh-accesses${current ? `/${current.id}` : ''}`, {
          method: current ? 'PUT' : 'POST',
          body: json({
            name: value(data, 'name'),
            platform: value(data, 'platform'),
            ssh: {
              host: value(data, 'host'),
              port: Number(value(data, 'port')),
              username: value(data, 'username'),
              identityFile: value(data, 'identityFile'),
              reconnectIntervalSeconds: Number(value(data, 'reconnect')),
            },
            bindings,
            ...(current ? { revision: current.revision } : {}),
          }),
        });
        done();
      }}
    >
      <div className="form-grid">
        <Field label="接入名称">
          <Input
            name="name"
            defaultValue={current?.name}
            required
            placeholder="例如：办公室 Windows"
          />
        </Field>
        <Field label="设备系统">
          <SelectControl name="platform" defaultValue={current?.platform ?? 'windows'}>
            {['windows', 'macos', 'linux', 'other'].map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectControl>
        </Field>
        <Field label="SSH 主机">
          <Input
            name="host"
            defaultValue={current?.ssh.host}
            placeholder="ssh.example.com"
            required
          />
        </Field>
        <Field label="SSH 端口">
          <Input
            type="number"
            name="port"
            defaultValue={current?.ssh.port ?? 22}
            min={1}
            max={65535}
            required
          />
        </Field>
        <Field label="SSH 用户">
          <Input name="username" defaultValue={current?.ssh.username} autoComplete="off" required />
        </Field>
        <Field label="设备上的私钥路径" hint="只保存路径；私钥保留在设备上。">
          <Input
            name="identityFile"
            defaultValue={current?.ssh.identityFile ?? '~/.ssh/id_ed25519'}
            required
          />
        </Field>
        <Field label="断线重连间隔（秒）">
          <Input
            type="number"
            name="reconnect"
            defaultValue={current?.ssh.reconnectIntervalSeconds ?? 5}
            min={1}
            required
          />
        </Field>
      </div>
      <h3>转发已有 MCP</h3>
      <p>
        先在连接页创建平台执行的 HTTP/SSE MCP，URL 使用 http://127.0.0.1:远端端口/原路径。SSH
        服务须与平台处于同一网络空间。
      </p>
      {bindings.map((binding, index) => (
        <fieldset key={index} className="form-grid">
          <legend>映射 {index + 1}</legend>
          <Field label={`映射 ${index + 1} 的连接`}>
            <SelectControl
              required
              value={binding.connectionId}
              onValueChange={(connectionId) =>
                setBindings(bindings.map((b, i) => (i === index ? { ...b, connectionId } : b)))
              }
            >
              <SelectItem value="">选择现有连接</SelectItem>
              {connections.map((connection) => (
                <SelectItem key={connection.id} value={connection.id}>
                  {connection.name}
                </SelectItem>
              ))}
            </SelectControl>
          </Field>
          {(['localPort', 'remotePort'] as const).map((key) => (
            <Field
              key={key}
              label={`映射 ${index + 1} 的${key === 'localPort' ? '本机' : '远端'}端口`}
            >
              <Input
                type="number"
                required
                min={1}
                max={65535}
                value={binding[key]}
                onChange={(event) =>
                  setBindings(
                    bindings.map((b, i) =>
                      i === index ? { ...b, [key]: Number(event.target.value) } : b,
                    ),
                  )
                }
              />
            </Field>
          ))}
          <Button
            variant="outline"
            type="button"
            disabled={bindings.length === 1}
            onClick={() => setBindings(bindings.filter((_, i) => i !== index))}
          >
            移除映射 {index + 1}
          </Button>
        </fieldset>
      ))}
      <Button
        variant="outline"
        type="button"
        onClick={() =>
          setBindings([...bindings, { connectionId: '', localPort: 3000, remotePort: 13000 }])
        }
      >
        增加端口映射
      </Button>
    </Form>
  );
}
