import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog.js';
import { InlineStatus } from '../../components/shared/Controls.js';
import { ConnectionForm } from '../connections/ConnectionForm.js';
import { connectNow, type ConnectOutcome } from '../connections/connectNow.js';
import { connectionNextStep } from '../connections/connectionHints.js';
import { api, type Connection, type Device } from '../../lib/api.js';

export function DeviceToolsDialog({ device }: { device: Device }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<ConnectOutcome & { connection?: Connection }>();
  const [retrying, setRetrying] = useState(false);
  const query = useQueryClient();
  async function show(result: ConnectOutcome) {
    const connection = await api<Connection>(`/connections/${result.connectionId}`).catch(
      () => undefined,
    );
    setOutcome({ ...result, connection });
    await query.invalidateQueries();
  }
  const name = outcome?.connection?.name ? `「${outcome.connection.name}」` : '';
  return (
    <div className="grid gap-2">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button variant="outline" size="sm" />}>
          <Plus size={16} /> 添加本机工具
        </DialogTrigger>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>给 {device.name} 添加工具</DialogTitle>
            <DialogDescription>
              命令在这台电脑上运行，所需运行时和系统权限需提前准备好。保存后立即连接并读取工具。
            </DialogDescription>
          </DialogHeader>
          <ConnectionForm
            key={device.id}
            devices={[device]}
            initialDeviceId={device.id}
            onConnected={async (result) => {
              setOpen(false);
              await show(result);
            }}
          />
        </DialogContent>
      </Dialog>
      {outcome && !outcome.error ? (
        <p className="text-sm">
          <InlineStatus>
            已连接{name}，读取到 {outcome.tools ?? 0} 个工具
          </InlineStatus>{' '}
          <Link to="/tools" search={{ connectionId: outcome.connectionId }}>
            查看工具
          </Link>
        </p>
      ) : outcome?.error ? (
        <div role="alert" className="attention stacked text-sm">
          <p className="m-0 font-medium">已保存{name}，但没有连上</p>
          <p className="m-0 break-words">{outcome.error.message}</p>
          <p className="m-0">
            {connectionNextStep(
              outcome.connection ?? {
                adapter: 'device',
                transport: 'stdio',
                mode: 'managed',
                deviceId: device.id,
                deviceOffline: !device.online,
              },
              outcome.error.message,
              outcome.error.code,
            )}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={retrying}
              onClick={async () => {
                setRetrying(true);
                try {
                  await show(await connectNow(outcome.connectionId));
                } finally {
                  setRetrying(false);
                }
              }}
            >
              重试连接
            </Button>
            <Button
              size="sm"
              variant="ghost"
              render={<Link to="/connections" hash={`connection-${outcome.connectionId}`} />}
            >
              编辑连接
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
