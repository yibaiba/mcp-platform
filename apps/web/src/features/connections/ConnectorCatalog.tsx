import { connectorPresets, type ConnectorPreset } from '@platform/contracts';
import { BookOpen, Check, ChevronDown, Cloud, Github, ListTodo, Notebook } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
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
const icons = {
  cloudflare: Cloud,
  github: Github,
  notion: Notebook,
  linear: ListTodo,
  'cloudflare-docs': BookOpen,
};

function ConnectorRow({
  preset,
  connections,
  onSelect,
}: {
  preset: ConnectorPreset;
  connections: readonly Connection[];
  onSelect: (preset: ConnectorPreset) => void;
}) {
  const matches = connections.filter(
    (connection) => connection.url?.replace(/\/$/, '') === preset.url.replace(/\/$/, ''),
  );
  const existing = matches.find((connection) => connection.status === 'connected') ?? matches[0];
  const Icon = icons[preset.id as keyof typeof icons];
  return (
    <div className="flex min-w-0 items-center gap-3 py-2">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-foreground">
        <Icon size={20} aria-hidden="true" />
      </div>
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
              <DropdownMenuItem
                key={connection.id}
                onClick={() => {
                  window.location.hash = `connection-${connection.id}`;
                }}
              >
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
  connections,
}: {
  onSelect: (preset: ConnectorPreset) => void;
  connections: readonly Connection[];
}) {
  return (
    <Card className="mb-6 gap-5 p-5" aria-labelledby="connector-catalog-title">
      <div>
        <h2 id="connector-catalog-title">内置连接器</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          选择服务，配置账号后自动连接。连接成功后，在工作空间授予 Agent 使用。
        </p>
      </div>
      {groups.map((group) => (
        <section key={group.name} aria-label={group.name}>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">{group.name}</h3>
          <div className="grid gap-x-10 gap-y-1 md:grid-cols-2">
            {connectorPresets
              .filter((preset) => preset.category === group.category)
              .map((preset) => (
                <ConnectorRow
                  key={preset.id}
                  preset={preset}
                  connections={connections}
                  onSelect={onSelect}
                />
              ))}
          </div>
        </section>
      ))}
    </Card>
  );
}
