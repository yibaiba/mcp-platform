import { connectorPresets, type ConnectorPreset } from '@platform/contracts';
import { Check, ChevronDown } from 'lucide-react';
import { ConnectorIcon } from './ConnectorIcon.js';
import { Button } from '../../components/ui/button.js';
import type { Connection } from '../../lib/api.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';

const groups = [
  { name: '开发与云服务', category: 'development' },
  { name: '效率与文档', category: 'productivity' },
] as const;

function ConnectorRow({
  preset,
  connections,
  onSelect,
  onManage,
}: {
  preset: ConnectorPreset;
  connections: readonly Connection[];
  onSelect: (preset: ConnectorPreset) => void;
  onManage: (connection: Connection) => void;
}) {
  const matches = connections.filter(
    (connection) =>
      connection.presetId === preset.id ||
      connection.url?.replace(/\/$/, '') === preset.url.replace(/\/$/, ''),
  );
  const existing = matches.find((connection) => connection.status === 'connected') ?? matches[0];
  return (
    <div className="flex min-w-0 items-center gap-3 py-2">
      <ConnectorIcon presetId={preset.id} />
      <div className="min-w-0 flex-1">
        <a
          href={preset.documentationUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${preset.name} 官方文档（新窗口）`}
          className="text-sm font-medium hover:underline focus-visible:outline focus-visible:outline-ring"
        >
          {preset.name}
        </a>
        <p className="truncate text-xs text-muted-foreground" title={preset.description}>
          {preset.description}
        </p>
      </div>
      {existing ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" className="h-9 min-w-16 rounded-full text-xs" />}
            aria-label={`管理 ${preset.name}`}
          >
            {existing.status === 'connected' ? (
              <>
                <Check size={14} aria-hidden="true" /> 已连接
              </>
            ) : (
              '管理'
            )}
            <ChevronDown size={12} aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {matches.map((connection) => (
              <DropdownMenuItem key={connection.id} onClick={() => onManage(connection)}>
                管理 {connection.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onClick={() => onSelect(preset)}>
              添加另一个 {preset.name}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          variant="secondary"
          className="h-9 min-w-16 rounded-full text-xs"
          aria-label={`添加 ${preset.name}`}
          onClick={() => onSelect(preset)}
        >
          添加
        </Button>
      )}
    </div>
  );
}

export function ConnectorCatalog({
  onSelect,
  onManage,
  connections,
}: {
  onSelect: (preset: ConnectorPreset) => void;
  onManage: (connection: Connection) => void;
  connections: readonly Connection[];
}) {
  return (
    <div className="grid gap-5" aria-label="内置服务">
      {groups.map((group) => (
        <section key={group.name} aria-label={group.name}>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">{group.name}</h3>
          <div className="grid gap-y-1">
            {connectorPresets
              .filter((preset) => preset.category === group.category)
              .map((preset) => (
                <ConnectorRow
                  key={preset.id}
                  preset={preset}
                  connections={connections}
                  onSelect={onSelect}
                  onManage={onManage}
                />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
