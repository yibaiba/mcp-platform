import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { authClient } from '../../lib/auth-client.js';
import { Input } from '../../components/ui/input.js';
import { Card } from '../../components/ui/card.js';
import { Action, date, Field, Feedback, Form, value } from '../../components/shared/Controls.js';
import type { LoginOptions } from '../../components/shared/AuthScreen.js';
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
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>个人账号</h1>
          <p>修改密码、绑定登录身份或撤销登录会话。</p>
        </div>
      </div>
      <Feedback error={sessions.error ?? options.error} />
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
