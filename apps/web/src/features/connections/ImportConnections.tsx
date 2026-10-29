import { useState } from 'react';
import type { Connection, Device } from '../../lib/api.js';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '../../components/ui/dialog.js';
import { BundlePanel } from '../bundles/BundlePanel.js';
import { OpenApiPanel } from './OpenApiPanel.js';
import { ImportPanel } from './ImportPanel.js';
const methods = [
  ['mcpb', 'MCPB 扩展包'],
  ['openapi', 'OpenAPI 文档'],
  ['json', 'MCP 配置 JSON'],
] as const;
export function ImportConnections({
  devices,
  connections,
}: {
  devices: Device[];
  connections: Connection[];
}) {
  const [method, setMethod] = useState('mcpb');
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" />}>导入连接</DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>导入连接</DialogTitle>
          <DialogDescription>选择已有扩展包或配置文件，先预览再确认添加。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2" role="group" aria-label="导入方式">
          {methods.map(([key, label]) => (
            <Button
              key={key}
              variant={method === key ? 'default' : 'outline'}
              aria-pressed={method === key}
              onClick={() => setMethod(key)}
            >
              {label}
            </Button>
          ))}
        </div>
        <div hidden={method !== 'mcpb'}>
          <BundlePanel devices={devices} connections={connections} defaultOpen />
        </div>
        <div hidden={method !== 'openapi'}>
          <OpenApiPanel defaultOpen />
        </div>
        <div hidden={method !== 'json'}>
          <ImportPanel devices={devices} defaultOpen />
        </div>
      </DialogContent>
    </Dialog>
  );
}
