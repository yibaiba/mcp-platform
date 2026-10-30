import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ClientAuthMode } from '@platform/contracts';
import { api, json, type Profile } from '../../lib/api.js';
import {
  Action,
  Code,
  ErrorState,
  Feedback,
  Field,
  ListSkeleton,
} from '../../components/shared/Controls.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { Button } from '../../components/ui/button.js';
import { ClientExportBody, ClientPicker, useClientPreset, type Export } from './ClientExport.js';
import { OriginNotice } from '../../components/shared/OriginNotice.js';
import { useMe } from '../../lib/me.js';

export type IssuedAccess = { profileId: string; exports?: Export[]; revoked?: string[] };
export type AccessKey = { id: string; profileId: string; revoked: boolean };

export function ProfileAccess({
  profile,
  permissionsSaved,
  connectionId,
  onIssued,
}: {
  profile: Profile;
  permissionsSaved?: boolean;
  connectionId?: string;
  onIssued: (result: IssuedAccess) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (permissionsSaved) heading.current?.focus();
  }, [permissionsSaved, profile.id]);
  const queryClient = useQueryClient();
  const keys = useQuery({
    queryKey: ['keys'],
    queryFn: () => api<AccessKey[]>('/profiles/keys/all'),
  });
  const active = keys.data?.filter((key) => key.profileId === profile.id && !key.revoked);
  // Client configs must point at PUBLIC_URL, not whatever origin this page was opened from.
  const platformOrigin = useMe().data?.platformOrigin;
  const [preset, setPreset] = useClientPreset();
  const [auth, setAuth] = useState<ClientAuthMode>('oauth');
  const [confirmingKey, setConfirmingKey] = useState(false);
  const [issueError, setIssueError] = useState<Error | null>(null);
  const issue = async (replace: boolean) => {
    setIssueError(null);
    try {
      const issued = await api<{ exports?: Export[]; revoked?: string[] }>(
        `/profiles/${profile.id}/keys`,
        { method: 'POST', body: json({ replace }) },
      );
      setConfirmingKey(false);
      await queryClient.invalidateQueries({ queryKey: ['keys'] });
      onIssued({ ...issued, profileId: profile.id });
    } catch (error) {
      setIssueError(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return (
    <div className="grid gap-5">
      {permissionsSaved ? (
        <p role="status" className="rounded-lg border p-3 text-sm">
          「{profile.name}
          」的权限已保存。已接入的客户端刷新工具列表即可；还没接入的，在下面选择客户端。
        </p>
      ) : null}
      <section className="grid gap-3" aria-label="连接客户端">
        <h3 ref={heading} tabIndex={-1} className="outline-none">
          接入客户端
        </h3>
        <ClientPicker value={preset} onChange={setPreset} />
        <div className="segmented" role="group" aria-label="认证方式">
          <Button
            size="sm"
            variant={auth === 'oauth' ? 'secondary' : 'ghost'}
            aria-pressed={auth === 'oauth'}
            onClick={() => setAuth('oauth')}
          >
            浏览器授权（推荐）
          </Button>
          <Button
            size="sm"
            variant={auth === 'key' ? 'secondary' : 'ghost'}
            aria-pressed={auth === 'key'}
            onClick={() => setAuth('key')}
          >
            接入密钥
          </Button>
        </div>
        {auth === 'oauth' ? (
          <>
            <p className="text-sm text-muted-foreground">
              配置里只有地址，不含密钥。客户端第一次连接时会打开浏览器，登录平台后点「允许」即可；随时可在「授权」里撤销。
            </p>
            <OriginNotice platformOrigin={platformOrigin} />
            <Field label="MCP 地址">
              <Code value={`${platformOrigin ?? ''}/mcp/${profile.id}`} />
            </Field>
            <ClientExportBody profileId={profile.id} auth="oauth" preset={preset} />
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              给不支持浏览器授权的客户端或脚本使用。密钥只在生成时显示一次。
            </p>
            {confirmingKey ? (
              <div role="alertdialog" aria-label="已有有效密钥" className="attention">
                <div className="grow">
                  <strong>这个 Agent 已有 {active?.length} 把有效密钥。</strong>
                  <p>
                    撤销旧密钥后，仍在用旧密钥的客户端会立即失效。不确定旧密钥是否还在用时，可以先保留。
                  </p>
                </div>
                <div className="flex shrink-0 flex-col gap-2">
                  <Button onClick={() => void issue(true)}>撤销旧密钥并生成</Button>
                  <Button variant="outline" onClick={() => void issue(false)}>
                    保留旧密钥，再生成一把
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmingKey(false)}>
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <Button
                  onClick={() => (active?.length ? setConfirmingKey(true) : void issue(false))}
                >
                  生成接入密钥
                </Button>
              </div>
            )}
            <Feedback error={issueError} />
            <Disclosure title="已有密钥？查看客户端配置（不含密钥）">
              <p className="my-3 text-sm text-muted-foreground">
                模板使用凭证占位符，请填入你保存的接入密钥。
              </p>
              <ClientExportBody profileId={profile.id} auth="key" preset={preset} />
            </Disclosure>
          </>
        )}
      </section>
      <Button
        variant="outline"
        render={<Link to="/tools" search={{ profileId: profile.id, connectionId }} />}
      >
        以此 Agent 测试工具
      </Button>
      <p className="text-sm text-muted-foreground">
        复制配置不代表客户端已经接通。请在客户端刷新工具列表；平台测试需选择工具并主动点击执行。
      </p>
      <Disclosure title={`管理已有接入密钥${active ? `（${active.length}）` : ''}`}>
        <ErrorState title="接入密钥加载失败" error={keys.error} onRetry={() => keys.refetch()} />
        {keys.isPending ? <ListSkeleton rows={2} /> : null}
        {active?.map((key) => (
          <div className="row" key={key.id}>
            <code className="grow">{key.id.slice(0, 8)}…</code>
            <Action
              danger
              confirmation={{
                title: `撤销密钥 ${key.id.slice(0, 8)}…？`,
                description: '使用它的客户端会立即失效。',
                confirmLabel: '撤销',
              }}
              action={() => api(`/profiles/keys/${key.id}`, { method: 'DELETE' })}
            >
              撤销密钥
            </Action>
          </div>
        ))}
        {active?.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有有效的接入密钥。</p>
        ) : null}
      </Disclosure>
    </div>
  );
}
