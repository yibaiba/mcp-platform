import { useState } from 'react';
import { Link } from '@tanstack/react-router';
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
import { ConnectionForm } from '../connections/ConnectionForm.js';
import type { Device } from '../../lib/api.js';

export function DeviceToolsDialog({ device }: { device: Device }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <div className="grid gap-2">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button variant="outline" />}>
          <Plus size={16} /> 添加本机工具
        </DialogTrigger>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>给 {device.name} 添加工具</DialogTitle>
            <DialogDescription>
              命令在这台电脑上运行。填写已有 MCP
              的启动命令和参数；Node.js、Python、浏览器及系统权限需在这台电脑准备好。
            </DialogDescription>
          </DialogHeader>
          <ConnectionForm
            key={device.id}
            devices={[device]}
            initialDeviceId={device.id}
            onSaved={() => {
              setOpen(false);
              setSaved(true);
            }}
          />
        </DialogContent>
      </Dialog>
      {saved ? (
        <p role="status" className="text-sm text-muted-foreground">
          已保存。到 <Link to="/connections">MCP 连接</Link> 点击“连接”发现工具，再授予 Agent。
        </p>
      ) : null}
    </div>
  );
}
