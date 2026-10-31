import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, json, type Profile, type Artifact } from '../../lib/api.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Card } from '../../components/ui/card.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
import { Action, Code, Feedback, Field, Form, value } from '../../components/shared/Controls.js';
type Selection = {
  sourceTaskId: string;
  targetProfileId: string;
  targetRevision: number;
  summary: string;
  artifactIds: string[];
  mode: 'pi' | 'external';
  credentialId?: string;
};
export function HandoffPanel({ taskId, artifacts }: { taskId: string; artifacts: Artifact[] }) {
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<Profile[]>('/profiles') });
  const keys = useQuery({
    queryKey: ['keys'],
    queryFn: () => api<{ id: string; profileId: string; revoked: boolean }[]>('/profiles/keys/all'),
  });
  const grants = useQuery({
    queryKey: ['oauth-grants'],
    queryFn: () => api<{ id: string; profileId: string; revoked: boolean }[]>('/oauth/grants'),
  });
  const handoffs = useQuery({
    queryKey: ['handoffs'],
    queryFn: () =>
      api<{ id: string; sourceTaskId: string; status: string; error?: string }[]>('/handoffs'),
    refetchInterval: 3000,
  });
  const [preview, setPreview] = useState<{ selection: Selection; result: unknown; key: string }>();
  const [result, setResult] = useState<unknown>();
  const [target, setTarget] = useState('');
  return (
    <Card className="panel padded">
      <h2>主动交接</h2>
      <p>由你编写摘要并选择文件。预览后提交记录，执行需单独点击。</p>
      <Feedback error={profiles.error ?? keys.error ?? grants.error ?? handoffs.error} />
      <div onChange={() => setPreview(undefined)}>
        <Form
          label="预览交接"
          submit={async (data) => {
            const profile = profiles.data?.find((p) => p.id === value(data, 'target'));
            if (!profile) throw new Error('请选择目标 Agent');
            const selected: Selection = {
              sourceTaskId: taskId,
              targetProfileId: profile.id,
              targetRevision: profile.revision,
              summary: value(data, 'summary'),
              artifactIds: data.getAll('artifact').map(String),
              mode: value(data, 'mode') as Selection['mode'],
              credentialId: value(data, 'credential') || undefined,
            };
            setPreview({
              selection: selected,
              result: await api('/handoffs/preview', { method: 'POST', body: json(selected) }),
              key: crypto.randomUUID(),
            });
          }}
        >
          <Field label="目标 Agent">
            <SelectControl
              name="target"
              value={target}
              onValueChange={(v) => {
                setTarget(v ?? '');
                setPreview(undefined);
              }}
              required
            >
              <SelectItem value="">选择 Agent</SelectItem>
              {profiles.data?.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectControl>
          </Field>
          <Field label="交接摘要">
            <Textarea name="summary" required rows={4} />
          </Field>
          <fieldset>
            <legend>选定源任务文件</legend>
            {artifacts.map((a) => (
              <CheckChoice key={a.id} name="artifact" value={a.id}>
                <span>
                  {a.name} · {a.sha256.slice(0, 12)}
                </span>
              </CheckChoice>
            ))}
          </fieldset>
          <Field label="执行入口">
            <SelectControl
              name="mode"
              defaultValue="pi"
              onValueChange={() => setPreview(undefined)}
            >
              <SelectItem value="pi">内置 Pi 新任务</SelectItem>
              <SelectItem value="external">外部任务包</SelectItem>
            </SelectControl>
          </Field>
          <Field label="外部目标接入凭证">
            <SelectControl
              name="credential"
              defaultValue=""
              onValueChange={() => setPreview(undefined)}
            >
              <SelectItem value="">Pi 无需选择</SelectItem>
              {[...(keys.data ?? []), ...(grants.data ?? [])]
                .filter((k) => k.profileId === target && !k.revoked)
                .map((k) => (
                  <SelectItem key={k.id} value={k.id}>
                    {k.id}
                  </SelectItem>
                ))}
            </SelectControl>
          </Field>
        </Form>
      </div>
      {preview ? (
        <>
          <Code value={preview.result} />
          <Action
            action={async () => {
              setResult(
                await api('/handoffs', {
                  method: 'POST',
                  body: json({ ...preview.selection, idempotencyKey: preview.key }),
                }),
              );
              setPreview(undefined);
            }}
          >
            提交交接记录
          </Action>
        </>
      ) : null}
      {handoffs.data
        ?.filter((h) => h.sourceTaskId === taskId)
        .map((handoff) => (
          <section className="connection-row" key={handoff.id}>
            <p>
              {handoff.id} · {handoff.status}
            </p>
            {handoff.error ? <p className="error">{handoff.error}</p> : null}
            <div className="row-actions">
              <Action action={async () => setResult(await api(`/handoffs/${handoff.id}/export`))}>
                查看 / 导出任务包
              </Action>
              <Action
                action={async () =>
                  setResult(await api(`/handoffs/${handoff.id}/execute`, { method: 'POST' }))
                }
              >
                显式执行交接
              </Action>
            </div>
          </section>
        ))}
      {result ? <Code value={result} /> : null}
    </Card>
  );
}
