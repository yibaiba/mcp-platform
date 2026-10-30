import { PageHeader } from '../../components/shared/PageHeader.js';
import { CliGrants } from './CliGrants.js';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { authClient } from '../../lib/auth-client.js';
import { Input } from '../../components/ui/input.js';
import { Card } from '../../components/ui/card.js';
import { Action, date, Field, Feedback, Form, value } from '../../components/shared/Controls.js';
import type { LoginOptions } from '../../components/shared/AuthScreen.js';
import { Badge } from '../../components/ui/badge.js';
import { roleLabel, useMe } from '../../lib/me.js';
type Session = {
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipAddress: string | null;
};

export default function AccountPage() {
  const sessions = useQuery({
    queryKey: ['my-sessions'],
    queryFn: () => api<Session[]>('/me/sessions'),
  });
  const options = useQuery({
    queryKey: ['login-options'],
    queryFn: () => api<LoginOptions>('/login-options'),
  });
  const me = useMe();
  const session = authClient.useSession();
  const role = me.data?.role;
  return (
    <>
      <PageHeader title="个人账号" />
      <Feedback error={sessions.error ?? options.error ?? me.error} />
      <Card className="panel padded" aria-label="账号与角色">
        <h2>账号与角色</h2>
        <dl className="account-role-summary">
          <dt>账号</dt>
          <dd>{session.data?.user.email ?? '—'}</dd>
          <dt>角色</dt>
          <dd>
            {role ? (
              <Badge variant={role === 'admin' ? 'secondary' : 'outline'}>{roleLabel[role]}</Badge>
            ) : (
              '读取中…'
            )}
          </dd>
        </dl>
        {role === 'admin' ? (
          <p>管理员可以管理用户、网络与安装源和平台设置；在“用户管理”里可以调整其他账号的角色。</p>
        ) : role === 'member' ? (
          <p>
            普通用户可以管理自己的连接和
            Agent。需要管理员权限时，请联系平台管理员在“用户管理”里调整。
          </p>
        ) : null}
      </Card>
      <CliGrants />
      <Card className="panel padded">
        <h2>修改密码</h2>
        <Form
          label="更新密码并退出其他登录会话"
          submit={async (data) => {
            const result = await authClient.changePassword({
              currentPassword: value(data, 'currentPassword'),
              newPassword: value(data, 'newPassword'),
              revokeOtherSessions: true,
            });
            if (result.error) throw new Error(result.error.message ?? '密码修改失败');
          }}
        >
          <Field label="当前密码">
            <Input
              type="password"
              name="currentPassword"
              autoComplete="current-password"
              required
            />
          </Field>
          <Field label="新密码">
            <Input
              type="password"
              name="newPassword"
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
              required
            />
          </Field>
        </Form>
      </Card>
      <Card className="panel padded">
        <h2>登录身份</h2>
        <p>绑定需要先登录当前账号，再完成供应商授权；相同邮箱不会自动合并账号。</p>
        {options.data?.providers.map((provider) => (
          <Action
            key={provider.id}
            action={async () => {
              const result =
                provider.kind === 'oauth2'
                  ? await authClient.oauth2.link({
                      providerId: provider.id,
                      callbackURL: '/account',
                    })
                  : await authClient.linkSocial({ provider: provider.id, callbackURL: '/account' });
              if (result.error) throw new Error(result.error.message ?? '身份绑定失败');
            }}
          >
            绑定 {provider.name}
          </Action>
        ))}
      </Card>
      <Card className="panel padded">
        <h2>活跃登录会话</h2>
        {sessions.data?.map((session) => (
          <div key={session.id} className="panel padded">
            <p>
              {session.userAgent ?? '未报告客户端'} · {session.ipAddress ?? '未报告 IP'}
            </p>
            <small>
              {date(session.createdAt)} — {date(session.expiresAt)}
            </small>
            <Action
              danger
              confirmation={{
                title: '撤销这个登录会话？',
                description: '使用该会话的浏览器需要重新登录。',
                confirmLabel: '撤销',
              }}
              action={async () => {
                await api(`/me/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
                window.location.reload();
              }}
            >
              撤销会话
            </Action>
          </div>
        ))}
      </Card>
    </>
  );
}
