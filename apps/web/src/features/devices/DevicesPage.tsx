import { PageHeader } from '../../components/shared/PageHeader.js';
import { lazy, Suspense, useState } from 'react';
import { RePairDevice } from './RePairDevice.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { Card } from '../../components/ui/card.js';
import { useQuery } from '@tanstack/react-query';
import { Monitor } from 'lucide-react';
import { api, type Device } from '../../lib/api.js';
import { DevicePairing } from './DevicePairing.js';
import { DeviceToolsDialog } from './DeviceToolsDialog.js';
import {
  Action,
  Code,
  date,
  Empty,
  Feedback,
  Status,
  ListSkeleton,
} from '../../components/shared/Controls.js';
const SshAccesses = lazy(() => import('./SshAccesses.js'));
const DeviceLocalManager = lazy(() => import('../local/DeviceLocalManager.js'));
export default function DevicesPage() {
  const [localDevice, setLocalDevice] = useState<string>();
  const platform = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ platformOrigin: string }>('/me'),
  });
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api<Device[]>('/devices'),
    refetchInterval: 15_000,
  });
  return (
    <>
      <PageHeader title="设备" info="连接器主动连接平台，设备无需开放公网端口。" />
      <Feedback error={devices.error ?? platform.error} />
      <DevicePairing />
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
                <Status
                  value={
                    device.revoked
                      ? 'revoked'
                      : device.pairingRequired
                        ? 'pairing_required'
                        : device.online
                          ? 'online'
                          : 'offline'
                  }
                />
              </div>
              <div className="row-actions">
                {!device.revoked ? (
                  <button
                    className="button"
                    aria-expanded={localDevice === device.id}
                    onClick={() =>
                      setLocalDevice(localDevice === device.id ? undefined : device.id)
                    }
                  >
                    管理本机 MCP / Skills
                  </button>
                ) : null}
                <small>最近通信：{date(device.lastSeen)}</small>
                {!device.revoked ? <DeviceToolsDialog device={device} /> : null}
                {!device.revoked ? (
                  <Action
                    danger
                    confirmation={{
                      title: `撤销「${device.name}」？`,
                      description: '设备将断开，需重新配对。',
                      confirmLabel: '撤销',
                    }}
                    action={() => api(`/devices/${device.id}`, { method: 'DELETE' })}
                  >
                    撤销设备
                  </Action>
                ) : null}
              </div>
              {!device.revoked && platform.data ? (
                <RePairDevice device={device} platformOrigin={platform.data.platformOrigin} />
              ) : null}
              {localDevice === device.id && !device.revoked ? (
                <Suspense fallback={<ListSkeleton rows={2} />}>
                  <DeviceLocalManager deviceId={device.id} />
                </Suspense>
              ) : null}
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
      <Suspense fallback={<ListSkeleton rows={2} />}>
        <SshAccesses />
      </Suspense>
    </>
  );
}
