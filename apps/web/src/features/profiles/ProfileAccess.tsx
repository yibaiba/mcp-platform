import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api, type Profile } from '../../lib/api.js';
import { Action, Code, ErrorState, Field, ListSkeleton } from '../../components/shared/Controls.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { Button } from '../../components/ui/button.js';
import { ClientExportBody, type Export } from './ClientExport.js';
import { OriginNotice } from '../../components/shared/OriginNotice.js';
import { useMe } from '../../lib/me.js';

export type IssuedAccess = { profileId: string; exports?: Export[] };
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
  const keys = useQuery({
    queryKey: ['keys'],
    queryFn: () => api<AccessKey[]>('/profiles/keys/all'),
  });
  const active = keys.data?.filter((key) => key.profileId === profile.id && !key.revoked);
  // Client configs must point at PUBLIC_URL, not whatever origin this page was opened from.
  const platformOrigin = useMe().data?.platformOrigin;
  return (
    <div className="grid gap-5">
      {permissionsSaved ? (
        <p role="status" className="rounded-lg border p-3 text-sm">
          「{profile.name}」的权限已保存。下一步：生成接入密钥，复制配置到客户端。
        </p>
      ) : null}
      <section className="grid gap-3" aria-label="连接客户端">
        <h3 ref={heading} tabIndex={-1} className="outline-none">
          接入客户端
        </h3>
        <p className="text-sm text-muted-foreground">
          生成密钥后选择客户端并复制配置，再粘贴到客户端的 MCP 设置。密钥只显示一次。
        </p>
        <Action
          variant="default"
          action={async () => {
            const issued = await api<{ exports?: Export[] }>(`/profiles/${profile.id}/keys`, {
              method: 'POST',
            });
            onIssued({ ...issued, profileId: profile.id });
          }}
        >
          生成接入密钥
        </Action>
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
      <Disclosure title="已有密钥？查看配置模板">
        <OriginNotice platformOrigin={platformOrigin} />
        <Field label="MCP 地址">
          <Code value={`${platformOrigin ?? ''}/mcp/${profile.id}`} />
        </Field>
        <p className="my-3 text-sm text-muted-foreground">
          模板使用凭证占位符，请填入你保存的接入密钥。
        </p>
        <ClientExportBody profileId={profile.id} />
      </Disclosure>
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
