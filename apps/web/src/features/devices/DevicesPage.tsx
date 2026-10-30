import { PageHeader } from '../../components/shared/PageHeader.js';
import { lazy, Suspense, useState } from 'react';
import { RePairDevice } from './RePairDevice.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft, Monitor, MoreHorizontal, Plus } from 'lucide-react';
import { api, type Device } from '../../lib/api.js';
import { DevicePairing } from './DevicePairing.js';
import { DeviceToolsDialog } from './DeviceToolsDialog.js';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog.js';
import { Hint } from '../../components/ui/tooltip.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet.js';
import {
  Code,
  date,
  Empty,
  Feedback,
  relativeTime,
  Status,
  ListSkeleton,
} from '../../components/shared/Controls.js';
const SshAccesses = lazy(() => import('./SshAccesses.js'));
const DeviceLocalManager = lazy(() => import('../local/DeviceLocalManager.js'));

type Pending = { kind: 'revoke' | 'repair' | 'diagnose'; device: Device };
const deviceStatus = (device: Device) =>
  device.revoked
    ? 'revoked'
    : device.pairingRequired
      ? 'pairing_required'
      : device.online
        ? 'online'
        : 'offline';

export default function DevicesPage() {
  const { tab, device: deviceId } = useSearch({ from: '/devices' });
  const navigate = useNavigate({ from: '/devices' });
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Pending>();
  const [actionError, setActionError] = useState<Error | null>(null);
  const platform = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ platformOrigin: string }>('/me'),
  });
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api<Device[]>('/devices'),
    refetchInterval: 15_000,
  });
  if (tab === 'ssh')
    return (
      <>
        <PageHeader title="设备" />
        <Suspense fallback={<ListSkeleton rows={2} />}>
          <SshAccesses />
        </Suspense>
      </>
    );
  if (deviceId) {
    const device = devices.data?.find((item) => item.id === deviceId);
    return (
      <>
        <PageHeader
          title={device?.name ?? '设备'}
          badge={device ? <Status value={deviceStatus(device)} /> : null}
          actions={
            <Button variant="ghost" onClick={() => void navigate({ search: {} })}>
              <ArrowLeft aria-hidden="true" /> 返回
            </Button>
          }
        />
        <Feedback error={devices.error} />
        {devices.isPending ? <ListSkeleton rows={2} /> : null}
        {device && !device.revoked ? (
          <Suspense fallback={<ListSkeleton rows={2} />}>
            <DeviceLocalManager deviceId={device.id} />
          </Suspense>
        ) : devices.isSuccess ? (
          <Empty title={device ? '设备已撤销' : '找不到这台设备'} />
        ) : null}
      </>
    );
  }
  const close = () => setPending(undefined);
  return (
    <>
      <PageHeader
        title="设备"
        info="连接器主动连接平台，设备无需开放公网端口。"
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            添加设备
          </Button>
        }
      />
      <Feedback error={devices.error ?? platform.error ?? actionError} />
      <Card className="panel">
        {devices.isPending ? <ListSkeleton /> : null}
        {devices.data?.length ? (
          devices.data.map((device) => (
            <div className="device-row" key={device.id}>
              <div className="item-icon">
                <Monitor size={18} aria-hidden="true" />
              </div>
              <div className="grow min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{device.name}</strong>
                  <Status value={deviceStatus(device)} />
                </div>
                <small>
                  {[device.os, device.hostname, device.version].filter(Boolean).join(' · ') ||
                    '等待设备上报'}
                  {' · '}
                  <Hint content={`最近通信：${date(device.lastSeen)}`}>
                    <span tabIndex={0}>{relativeTime(device.lastSeen)}</span>
                  </Hint>
                </small>
              </div>
              {!device.revoked ? <DeviceToolsDialog device={device} /> : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="ghost" size="icon" />}
                  aria-label={`${device.name} 更多操作`}
                >
                  <MoreHorizontal aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  {!device.revoked ? (
                    <DropdownMenuItem
                      onClick={() => void navigate({ search: { device: device.id } })}
                    >
                      管理本机 MCP / Skills
                    </DropdownMenuItem>
                  ) : null}
                  {!device.revoked && platform.data ? (
                    <DropdownMenuItem onClick={() => setPending({ kind: 'repair', device })}>
                      重新配对
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    disabled={!device.services.length}
                    onClick={() => setPending({ kind: 'diagnose', device })}
                  >
                    MCP 服务诊断
                  </DropdownMenuItem>
                  {!device.revoked ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setPending({ kind: 'revoke', device })}
                      >
                        撤销设备
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))
        ) : devices.isSuccess ? (
          <Empty
            icon={Monitor}
            title="还没有设备"
            action={
              <Button variant="outline" onClick={() => setAdding(true)}>
                添加设备
              </Button>
            }
          >
            需要在另一台电脑上运行工具时再添加。
          </Empty>
        ) : null}
      </Card>
      <Sheet open={adding} onOpenChange={setAdding}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>添加设备</SheetTitle>
            <SheetDescription>在要控制的电脑上安装连接器并配对。</SheetDescription>
          </SheetHeader>
          <DevicePairing />
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={pending?.kind === 'revoke'}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={`撤销「${pending?.device.name ?? ''}」？`}
        description="设备将断开，需重新配对。"
        confirmLabel="撤销"
        danger
        onConfirm={() => {
          const target = pending?.device;
          close();
          if (!target) return;
          setActionError(null);
          void api(`/devices/${target.id}`, { method: 'DELETE' })
            .catch((error: unknown) =>
              setActionError(error instanceof Error ? error : new Error(String(error))),
            )
            .finally(() => void queryClient.invalidateQueries({ queryKey: ['devices'] }));
        }}
      />
      <Dialog
        open={pending?.kind === 'repair' || pending?.kind === 'diagnose'}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {pending?.kind === 'repair' ? '重新配对' : 'MCP 服务诊断'} · {pending?.device.name}
            </DialogTitle>
            <DialogDescription>
              {pending?.kind === 'repair'
                ? '生成重配码会立即断开此设备。'
                : '设备上报的 MCP 服务状态。'}
            </DialogDescription>
          </DialogHeader>
          {pending?.kind === 'repair' && platform.data ? (
            <RePairDevice
              device={pending.device}
              platformOrigin={platform.data.platformOrigin}
              startConfirming
              onCancel={close}
            />
          ) : null}
          {pending?.kind === 'diagnose' ? <Code value={pending.device.services} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
