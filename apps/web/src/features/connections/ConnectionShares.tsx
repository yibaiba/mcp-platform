import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, json } from '../../lib/api.js';
import { Action, Feedback, Field, Form, value } from '../../components/shared/Controls.js';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
type Grant = {
  id: string;
  email: string;
  credentialMode: 'independent' | 'owner';
  version: number;
  toolIds: string[];
  contentIds: string[];
  revoked: boolean;
  teamShareId: string | null;
  enabled: boolean;
};
type TeamShare = {
  id: string;
  credentialMode: 'independent' | 'owner';
  toolIds: string[];
  contentIds: string[];
  version: number;
  revoked: boolean;
  members: number;
  excluded: number;
  direct: number;
} | null;
type Catalog = {
  tools: { id: string; name: string }[];
  content: { id: string; name: string; kind: string }[];
};

export function ConnectionShares({ connectionId }: { connectionId: string }) {
  const [editing, setEditing] = useState<Grant>();
  const base = `/connections/${connectionId}/shares`;
  const grants = useQuery({
    queryKey: ['shares', connectionId],
    queryFn: () => api<Grant[]>(base),
  });
  const catalog = useQuery({
    queryKey: ['share-catalog', connectionId],
    queryFn: () => api<Catalog>(`${base}/catalog`),
  });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ role: 'admin' | 'member' }>('/me'),
  });
  const [notice, setNotice] = useState<string>();
  // Team copies are summarised by the team section; the list shows direct grants and exclusions.
  const listed = grants.data?.filter((grant) => !grant.teamShareId || grant.revoked);
  return (
    <div className="form">
      <p>
        接收者只能使用选中的工具和内容，并需在自己的 Agent 中再次授权。设备管理、文件同步和 Skill
        安装不会随连接共享。
      </p>
      <Feedback error={grants.error ?? catalog.error} />
      {me.data?.role === 'admin' && (
        <TeamShareSection connectionId={connectionId} catalog={catalog.data} />
      )}
      {notice && <p role="status">{notice}</p>}
      {listed?.length ? <h3 className="text-sm font-medium">单独共享</h3> : null}
      {listed?.map((grant) => (
        <div key={grant.id} className="row flex-wrap">
          <span className="grow">
            {grant.email} ·{' '}
            {!grant.enabled
              ? '账号已停用（不生效）'
              : grant.revoked && grant.teamShareId
                ? '已从全员共享中排除'
                : grant.revoked
                  ? '已撤销'
                  : grant.credentialMode === 'owner'
                    ? '用我的账号凭证'
                    : '独立授权'}
          </span>
          <Button variant="outline" onClick={() => setEditing(grant)}>
            {grant.revoked ? '重新授权' : '编辑授权'}
          </Button>
          {!grant.revoked && (
            <Action
              danger
              confirmation={{
                title: '撤销这个共享？',
                description: '接收方将立即无法使用该连接。',
                confirmLabel: '撤销',
              }}
              action={async () => {
                const result = await api<{ fallback: 'team' | null }>(`${base}/${grant.id}`, {
                  method: 'DELETE',
                });
                setNotice(
                  result.fallback === 'team'
                    ? `已撤销对 ${grant.email} 的单独共享；该成员仍在全员共享中，改按全员共享的模式和工具生效。`
                    : undefined,
                );
              }}
            >
              撤销共享
            </Action>
          )}
        </div>
      ))}
      <Form
        key={`${editing?.id ?? 'new'}:${editing?.version ?? 0}`}
        label={editing ? '更新共享授权' : '创建共享授权'}
        submit={async (data) => {
          await api(base, {
            method: 'PUT',
            body: json({
              recipientEmail: value(data, 'email'),
              credentialMode: value(data, 'credentialMode'),
              toolIds: data.getAll('tools'),
              contentIds: data.getAll('content'),
              version: editing?.version,
            }),
          });
          setEditing(undefined);
        }}
      >
        <Field label="接收账号邮箱">
          <Input
            name="email"
            type="email"
            required
            defaultValue={editing?.email}
            readOnly={Boolean(editing)}
          />
        </Field>
        <Field
          label="凭证使用方式"
          hint="选择“用我的账号凭证”即明确允许接收者以你的上游身份使用所选能力，包括来源设备上的服务。"
        >
          <SelectControl
            name="credentialMode"
            defaultValue={editing?.credentialMode ?? 'independent'}
          >
            <SelectItem value="independent">接收者独立授权（默认）</SelectItem>
            <SelectItem value="owner">允许使用我的凭证或设备服务</SelectItem>
          </SelectControl>
        </Field>
        <fieldset className="form">
          <legend>允许使用的工具</legend>
          {catalog.data?.tools.map((tool) => (
            <CheckChoice
              key={tool.id}
              name="tools"
              value={tool.id}
              defaultChecked={editing?.toolIds.includes(tool.id)}
            >
              {tool.name}
            </CheckChoice>
          ))}
          {catalog.data?.tools.length === 0 && <p>目录中尚无工具，请先连接并完成真实发现。</p>}
        </fieldset>
        <fieldset className="form">
          <legend>允许使用的 Prompt 和 Resource</legend>
          {catalog.data?.content.map((entry) => (
            <CheckChoice
              key={entry.id}
              name="content"
              value={entry.id}
              defaultChecked={editing?.contentIds.includes(entry.id)}
            >
              {entry.kind} · {entry.name}
            </CheckChoice>
          ))}
        </fieldset>
        {editing && (
          <Button variant="outline" type="button" onClick={() => setEditing(undefined)}>
            取消编辑
          </Button>
        )}
      </Form>
    </div>
  );
}

function TeamShareSection({ connectionId, catalog }: { connectionId: string; catalog?: Catalog }) {
  const path = `/connections/${connectionId}/team-share`;
  const client = useQueryClient();
  const team = useQuery({
    queryKey: ['team-share', connectionId],
    queryFn: () => api<TeamShare>(path),
  });
  const active = team.data && !team.data.revoked ? team.data : undefined;
  const [mode, setMode] = useState<'independent' | 'owner'>();
  const chosen = mode ?? active?.credentialMode ?? 'independent';
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['team-share', connectionId] }),
      client.invalidateQueries({ queryKey: ['shares', connectionId] }),
    ]);
  return (
    <section className="form rounded-lg border p-3" aria-label="共享给所有成员">
      <h3 className="text-sm font-medium">共享给所有成员</h3>
      <p className="text-sm text-muted-foreground">
        {active
          ? `生效中 · ${active.members} 人可用${active.excluded ? ` · 已排除 ${active.excluded} 人` : ''}${active.direct ? ` · ${active.direct} 人按单独共享生效` : ''}。之后新加入的账号自动包含；停用的账号不包含。`
          : '把所选工具共享给除你以外的所有已启用账号（包括其他管理员），之后新加入的账号自动包含。已有单独共享的成员按单独共享生效。'}
      </p>
      <Feedback error={team.error} />
      <Form
        key={`team:${active?.version ?? 0}`}
        label={active ? '更新全员共享' : '共享给所有成员'}
        submit={async (data) => {
          await api(path, {
            method: 'PUT',
            body: json({
              credentialMode: chosen,
              toolIds: data.getAll('team-tools'),
              contentIds: data.getAll('team-content'),
              version: active?.version,
            }),
          });
          setMode(undefined);
          await refresh();
        }}
      >
        <Field
          label="凭证使用方式"
          hint="默认每个成员用自己的凭证独立授权。工具集在共享时固定，上游之后新增的工具不会自动加入。"
        >
          <SelectControl
            name="team-mode"
            value={chosen}
            onValueChange={(value) => setMode(value as 'independent' | 'owner')}
          >
            <SelectItem value="independent">成员各自独立授权（默认）</SelectItem>
            <SelectItem value="owner">所有成员使用我的凭证</SelectItem>
          </SelectControl>
        </Field>
        {chosen === 'owner' && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive"
          >
            所有成员都会以你的账号访问上游。上游看到的是你的身份，成员看不到你的凭证本身。
          </p>
        )}
        <fieldset className="form">
          <legend>共享的工具</legend>
          {catalog?.tools.map((tool) => (
            <CheckChoice
              key={tool.id}
              name="team-tools"
              value={tool.id}
              defaultChecked={active?.toolIds.includes(tool.id)}
            >
              {tool.name}
            </CheckChoice>
          ))}
          {catalog?.tools.length === 0 && <p>目录中尚无工具，请先连接并完成真实发现。</p>}
        </fieldset>
        {catalog?.content.length ? (
          <fieldset className="form">
            <legend>共享的 Prompt 和 Resource</legend>
            {catalog.content.map((entry) => (
              <CheckChoice
                key={entry.id}
                name="team-content"
                value={entry.id}
                defaultChecked={active?.contentIds.includes(entry.id)}
              >
                {entry.kind} · {entry.name}
              </CheckChoice>
            ))}
          </fieldset>
        ) : null}
      </Form>
      {active && (
        <Action
          danger
          confirmation={{
            title: '取消全员共享？',
            description: '所有通过全员共享使用该连接的成员将立即失去这些工具；单独共享不受影响。',
            confirmLabel: '取消全员共享',
          }}
          action={async () => {
            await api(path, { method: 'DELETE' });
            await refresh();
          }}
        >
          取消全员共享
        </Action>
      )}
    </section>
  );
}
