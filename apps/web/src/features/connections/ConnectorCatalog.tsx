import {
  connectorPresets,
  connectorAuthenticationLabels,
  type ConnectorPreset,
} from '@platform/contracts';
import { ArrowUpRight, Plus } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { Badge } from '../../components/ui/badge.js';

export function ConnectorCatalog({ onSelect }: { onSelect: (preset: ConnectorPreset) => void }) {
  return (
    <section aria-labelledby="connector-catalog-title" className="mb-6 space-y-4">
      <div>
        <h2 id="connector-catalog-title">内置连接器</h2>
        <p className="text-sm text-muted-foreground">
          选择官方服务，配置自己的账号。保存后完成认证并发现工具，再授予 Agent 使用。
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {connectorPresets.map((preset) => (
          <Card key={preset.id} className="flex min-w-0 flex-col gap-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">{preset.name}</h3>
              <Badge variant="outline">官方远程 MCP</Badge>
            </div>
            <p className="grow text-sm text-muted-foreground">{preset.description}</p>
            <p className="break-all text-xs text-muted-foreground">{new URL(preset.url).host}</p>
            <p className="text-xs text-muted-foreground">
              {preset.authentication
                .map((method) => connectorAuthenticationLabels[method])
                .join(' / ')}
            </p>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="outline" onClick={() => onSelect(preset)}>
                <Plus aria-hidden="true" />
                添加 {preset.name}
              </Button>
              <a
                href={preset.documentationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-10 items-center gap-1 text-sm text-primary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-ring"
                aria-label={`${preset.name} 官方文档（新窗口）`}
              >
                官方文档 <ArrowUpRight size={14} aria-hidden="true" />
              </a>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
