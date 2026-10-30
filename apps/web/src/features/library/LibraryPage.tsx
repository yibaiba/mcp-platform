import { useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { LibraryItem } from '@platform/contracts';
import { api, json } from '../../lib/api.js';
import {
  Action,
  Field,
  Empty,
  ErrorState,
  ListSkeleton,
} from '../../components/shared/Controls.js';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { LibraryEditor } from './LibraryEditor.js';
type Item = LibraryItem & { id: string; revision: number; contentId: string };
function initialItem(kind: 'prompt' | 'resource', selected?: Item): LibraryItem {
  if (selected) {
    const { id: _id, revision: _revision, contentId: _contentId, ...item } = selected;
    return item;
  }
  const common = { name: '', title: '', description: '', enabled: true };
  return kind === 'prompt'
    ? { ...common, kind, template: '', arguments: [] }
    : { ...common, kind, uri: '', mimeType: 'text/plain', content: '' };
}
export default function LibraryPage() {
  const [kind, setKind] = useState<'prompt' | 'resource'>('prompt');
  const [selected, setSelected] = useState<Item>();
  const [generation, setGeneration] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<() => void>();
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: dirty,
    withResolver: true,
  });
  const path = `/library/${kind === 'prompt' ? 'prompts' : 'resources'}`;
  const query = useQuery({ queryKey: ['library', kind], queryFn: () => api<Item[]>(path) });
  function reset(item?: Item) {
    setDirty(false);
    setSelected(item);
    setGeneration((n) => n + 1);
  }
  function change(action: () => void) {
    if (dirty) setPending(() => action);
    else action();
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>内容库</h1>
          <p>维护自己的提示词和静态资源，再到 Agent 配置授权使用。</p>
        </div>
      </div>
      <div className="library-kind">
        <Field label="内容类型">
          <select
            disabled={saving}
            value={kind}
            onChange={(e) => {
              const next = e.target.value as typeof kind;
              change(() => {
                setKind(next);
                reset();
              });
            }}
          >
            <option value="prompt">Prompt 提示词</option>
            <option value="resource">Resource 资源</option>
          </select>
        </Field>
      </div>
      <div className="overview-grid">
        <Card className="panel padded">
          <div className="section-heading">
            <h2>{selected ? '编辑内容' : '新建内容'}</h2>
            {selected ? (
              <Button disabled={saving} variant="outline" onClick={() => change(() => reset())}>
                新建另一条
              </Button>
            ) : null}
          </div>
          <LibraryEditor
            key={`${kind}:${generation}`}
            initial={initialItem(kind, selected)}
            onDirtyChange={setDirty}
            save={async (item) => {
              setSaving(true);
              try {
                await api(selected ? `${path}/${selected.id}` : path, {
                  method: selected ? 'PUT' : 'POST',
                  body: json({ ...item, ...(selected ? { revision: selected.revision } : {}) }),
                });
                reset();
              } finally {
                setSaving(false);
              }
            }}
          />
        </Card>
        <Card className="panel padded">
          <h2>我的内容</h2>
          <ErrorState error={query.error} title="加载失败" onRetry={() => query.refetch()} />
          {query.isPending ? <ListSkeleton rows={3} /> : null}
          {query.isSuccess && !query.data.length ? <Empty title="还没有内容" /> : null}
          {query.data?.map((item) => (
            <div key={item.id} className="space-y-2 border-b py-3">
              <strong className="break-all">{item.name}</strong>
              <p>
                {item.enabled ? '已启用' : '已停用'} · 修订 {item.revision}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={saving}
                  variant="outline"
                  onClick={() => change(() => reset(item))}
                >
                  编辑
                </Button>
                <Action
                  danger
                  confirmation={{
                    title: `删除“${item.name}”？`,
                    confirmLabel: '确认删除',
                    description:
                      '此内容及其 Agent 配置授权将被移除，后续无法通过这些授权使用。此操作无法撤销。',
                  }}
                  action={async () => {
                    await api(`${path}/${item.id}`, {
                      method: 'DELETE',
                      body: json({ revision: item.revision }),
                    });
                    if (selected?.id === item.id) reset();
                  }}
                >
                  删除
                </Action>
              </div>
            </div>
          ))}
        </Card>
      </div>
      <ConfirmDialog
        open={Boolean(pending) || blocker.status === 'blocked'}
        title="放弃未保存的修改？"
        description="当前草稿尚未保存，继续将丢失这些修改。"
        confirmLabel="放弃修改并继续"
        onOpenChange={(open) => {
          if (!open) {
            setPending(undefined);
            blocker.reset?.();
          }
        }}
        onConfirm={() => {
          setDirty(false);
          pending?.();
          setPending(undefined);
          blocker.proceed?.();
        }}
      />
    </>
  );
}
