import { Disclosure } from '../../components/shared/Disclosure.js';
import { Card } from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Monitor } from 'lucide-react';
import { api, json, type Device } from '../../lib/api.js';
import {
  Action,
  Code,
  date,
  Empty,
  Feedback,
  Field,
  Form,
  Status,
  value,
} from '../../components/shared/Controls.js';
export default function DevicesPage() {
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api<Device[]>('/devices'),
    refetchInterval: 15_000,
  });
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string }>();
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">DEVICES</span>
          <h1>设备</h1>
          <p>连接器主动连接平台，设备无需开放公网端口。</p>
        </div>
      </div>
      <Feedback error={devices.error} />
      <div className="overview-grid">
        <Card className="panel padded">
          <h2>配对新设备</h2>
          <Form
            label="生成一次性配对码"
            submit={async (data) =>
              setPairing(
                await api('/devices/pairings', {
                  method: 'POST',
                  body: json({ name: value(data, 'name') }),
                }),
              )
            }
          >
            <Field label="设备名称">
              <Input name="name" required placeholder="例如：设计工作站" />
            </Field>
          </Form>
          {pairing ? (
            <div className="result">
              <p>在设备上运行连接器，将配对码粘贴到提示符中。</p>
              <Code
                value={`connector pair --server ${window.location.origin} --config connector.json`}
              />
              <Code value={pairing.code} />
              <small>有效期至 {date(pairing.expiresAt)}，仅可使用一次。</small>
            </div>
          ) : null}
        </Card>
        <Card className="panel padded">
          <h2>连接器安装</h2>
          <p>从项目根目录运行构建命令，获取对应系统的可执行文件。</p>
          <Code value="cd platform\npnpm connector:build" />
          <p>配对后启动连接器：</p>
          <Code value="connector run --config connector.json" />
          <small>
            需要桌面会话的应用使用用户登录启动；后台任务使用系统服务。三平台说明见
            platform/docs/connector.md。
          </small>
        </Card>
      </div>
      <Card className="panel">
        <div className="panel-heading">
          <h2>已绑定设备</h2>
          <span className="label">每 15 秒刷新</span>
        </div>
        {devices.data?.length ? (
          devices.data.map((device) => (
            <div className="connection-row" key={device.id}>
              <div className="row">
                <div className="item-icon">
                  <Monitor size={20} />
                </div>
                <div className="grow">
                  <strong>{device.name}</strong>
                  <small>
                    {device.os ?? '尚未连接'} · {device.hostname ?? '等待设备上报'} ·{' '}
                    {device.version ?? '—'}
                  </small>
                </div>
                <Status value={device.revoked ? 'revoked' : device.online ? 'online' : 'offline'} />
              </div>
              <div className="row-actions">
                <small>最近通信：{date(device.lastSeen)}</small>
                {!device.revoked ? (
                  <Action danger action={() => api(`/devices/${device.id}`, { method: 'DELETE' })}>
                    撤销设备
                  </Action>
                ) : null}
              </div>
              {device.services.length ? (
                <Disclosure title="MCP 服务诊断">
                  <Code value={device.services} />
                </Disclosure>
              ) : null}
            </div>
          ))
        ) : (
          <Empty>尚未绑定设备。生成配对码，然后在目标设备上连接。</Empty>
        )}
      </Card>
    </>
  );
}
