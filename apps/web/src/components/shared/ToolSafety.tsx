import { useContext, useState, type ReactNode } from 'react';
import {
  onlyReadOnly,
  toolSafetyLabels,
  toolSafetyOrder,
  withoutDestructive,
  type ToolSafety,
} from '@platform/contracts';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { CheckChoice } from './CheckChoice.js';
import { FormChanges } from './formChanges.js';
import { cn } from '@/lib/utils';

export type SafetyTool = { id: string; name: string; safety: ToolSafety };
type Filter = ToolSafety | 'all';

const badgeClass: Record<ToolSafety, string> = {
  readOnly: 'border-success/40 text-success',
  additive: 'border-warning/40 text-warning',
  destructive: 'border-destructive/40 bg-destructive/10 text-destructive',
  undeclared: 'border-dashed border-border text-muted-foreground',
};

const badgeTitle: Record<ToolSafety, string> = {
  readOnly: '上游声明 readOnlyHint: true，不修改任何东西',
  additive: '上游声明 destructiveHint: false：会新增或修改，但不删除、不覆盖',
  destructive:
    '上游声明 destructiveHint: true，或声明了 readOnlyHint: false 却没说明是否破坏（MCP 默认按破坏性）',
  undeclared: '上游没有声明 readOnlyHint / destructiveHint，不确定是否会修改或删除数据',
};

export function SafetyBadge({ safety }: { safety: ToolSafety }) {
  return (
    <Badge
      variant="outline"
      className={cn('font-normal', badgeClass[safety])}
      title={badgeTitle[safety]}
      data-safety={safety}
    >
      {toolSafetyLabels[safety]}
    </Badge>
  );
}

/** Controlled tool checkboxes with a safety filter. Rows hidden by the filter stay submitted. */
export function useToolSelection(initial: readonly string[]) {
  const [selected, setSelected] = useState<readonly string[]>(() => [...new Set(initial)]);
  const [filter, setFilter] = useState<Filter>('all');
  const changed = useContext(FormChanges);
  return {
    selected,
    filter,
    setFilter,
    has: (id: string) => selected.includes(id),
    toggle: (id: string, checked: boolean) =>
      setSelected((current) =>
        checked ? [...new Set([...current, id])] : current.filter((item) => item !== id),
      ),
    replace: (next: readonly string[]) => {
      setSelected([...new Set(next)]);
      changed?.();
    },
  };
}
export type ToolSelection = ReturnType<typeof useToolSelection>;

export function SafetyChoice({
  tool,
  name,
  selection,
  children,
}: {
  tool: SafetyTool;
  name: string;
  selection: ToolSelection;
  children?: ReactNode;
}) {
  const shown = selection.filter === 'all' || selection.filter === tool.safety;
  return (
    <div hidden={!shown} data-tool={tool.name}>
      <CheckChoice
        name={name}
        value={tool.id}
        checked={selection.has(tool.id)}
        onCheckedChange={(checked) => selection.toggle(tool.id, checked)}
      >
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          {children ?? tool.name}
          <SafetyBadge safety={tool.safety} />
        </span>
      </CheckChoice>
    </div>
  );
}

/**
 * Filter chips and the bulk actions for the tools in scope ("只选只读", "排除破坏性").
 * "未声明" counts as possibly destructive: never picked by 只选只读, removed by 排除破坏性.
 */
export function SafetyToolbar({
  tools,
  selection,
  scope,
  selectAllLabel = '全选',
}: {
  tools: readonly SafetyTool[];
  selection: ToolSelection;
  /** Names what the buttons act on when the list also shows other tools. */
  scope?: string;
  selectAllLabel?: string;
}) {
  const [notice, setNotice] = useState<string>();
  if (!tools.length) return null;
  const count = (safety: ToolSafety) => tools.filter((tool) => tool.safety === safety).length;
  const inScope = new Set(tools.map((tool) => tool.id));
  const outside = selection.selected.filter((id) => !inScope.has(id));
  const chosen = () => selection.selected.filter((id) => inScope.has(id)).length;
  const apply = (next: readonly string[], message: string) => {
    selection.replace(next);
    setNotice(message);
  };
  const undeclared = count('undeclared');
  return (
    <div className="grid gap-2 rounded-md border border-border p-2" data-testid="tool-safety">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="按类型筛选">
        {(['all', ...toolSafetyOrder] as const).map((filter) =>
          filter === 'all' || count(filter) ? (
            <Button
              key={filter}
              type="button"
              size="sm"
              variant={selection.filter === filter ? 'secondary' : 'ghost'}
              aria-pressed={selection.filter === filter}
              onClick={() => selection.setFilter(filter)}
            >
              {filter === 'all' ? '全部' : toolSafetyLabels[filter]}{' '}
              {filter === 'all' ? tools.length : count(filter)}
            </Button>
          ) : null,
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!count('readOnly')}
          onClick={() => {
            const next = onlyReadOnly(tools);
            apply(
              [...outside, ...next],
              `已只选 ${next.length} 个只读工具${scope ? `（${scope}）` : ''}。`,
            );
          }}
        >
          只选只读
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            const before = chosen();
            const next = withoutDestructive(selection.selected, tools);
            selection.replace(next);
            const removed = before - next.filter((id) => inScope.has(id)).length;
            setNotice(
              removed
                ? `已取消 ${removed} 个破坏性或未声明的工具。`
                : '已选的工具里没有破坏性或未声明的工具。',
            );
          }}
        >
          排除破坏性
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() =>
            apply(
              [...outside, ...tools.map((tool) => tool.id)],
              `已勾选全部 ${tools.length} 个工具。`,
            )
          }
        >
          {selectAllLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => apply(outside, '已清空。')}>
          清空
        </Button>
        <span className="text-xs text-muted-foreground">
          已选 {chosen()} / {tools.length}
        </span>
      </div>
      <p className="m-0 text-xs text-muted-foreground">
        标签来自上游 MCP 服务自己声明的 annotations，只用来筛选，不是权限限制。
        {undeclared
          ? `${undeclared} 个工具「未声明」：上游没说明是否会修改数据，按可能有破坏性处理，「只选只读」不会选它，「排除破坏性」会取消它；确认安全后可以单独勾选。`
          : '「未声明」的工具按可能有破坏性处理。'}
      </p>
      {notice ? (
        <p role="status" className="m-0 text-xs">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
