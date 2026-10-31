import { Card } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { useState } from 'react';
import { Network } from 'lucide-react';
import { authClient } from '../../lib/auth-client.js';
import { Field, Form, value } from './Controls.js';
import { Button } from '../ui/button.js';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Action, Feedback } from './Controls.js';
export type LoginOptions = {
  registration: boolean;
  /** No account exists yet: the first sign-up is always open and becomes administrator. */
  firstAccount?: boolean;
  providers: { id: string; name: string; kind: string }[];
};
export function AuthScreen() {
  const [chosen, setRegister] = useState(false);
  const options = useQuery({
    queryKey: ['login-options'],
    queryFn: () => api<LoginOptions>('/login-options'),
  });
  const firstAccount = options.data?.firstAccount === true;
  const register = firstAccount || chosen;
  return (
    <main className="auth-screen">
      <div className="auth-brand">
        <Network size={32} />
        <span>
          MCP <b>Platform</b>
        </span>
      </div>
      <Card className="auth-card">
        <h1>{firstAccount ? '创建管理员账号' : register ? '注册' : '登录'}</h1>
        {firstAccount ? <p>这是第一个账号，注册后自动成为管理员。</p> : null}
        <Form
          label={register ? '注册' : '登录'}
          successLabel={register ? '已注册' : '已登录'}
          submit={async (data) => {
            const input = {
              email: value(data, 'email'),
              password: value(data, 'password'),
              name: value(data, 'name'),
            };
            const result = register
              ? await authClient.signUp.email(input)
              : await authClient.signIn.email(input);
            if (result.error) throw new Error(result.error.message ?? '登录失败');
            window.location.reload();
          }}
        >
          {register ? (
            <Field label="名称">
              <Input name="name" autoComplete="name" required />
            </Field>
          ) : null}
          <Field label="邮箱">
            <Input name="email" type="email" autoComplete="email" required />
          </Field>
          <Field label="密码">
            <Input
              name="password"
              type="password"
              minLength={8}
              autoComplete={register ? 'new-password' : 'current-password'}
              required
            />
          </Field>
        </Form>
        <Feedback error={options.error} />
        {options.data?.providers.map((provider) => (
          <Action
            key={provider.id}
            action={async () => {
              const result =
                provider.kind === 'oauth2'
                  ? await authClient.signIn.oauth2({
                      providerId: provider.id,
                      callbackURL: window.location.href,
                    })
                  : await authClient.signIn.social({
                      provider: provider.id,
                      callbackURL: window.location.href,
                    });
              if (result.error) throw new Error(result.error.message ?? '单点登录失败');
            }}
          >
            使用 {provider.name} 登录
          </Action>
        ))}
        {options.data?.registration && !firstAccount ? (
          <Button variant="ghost" onClick={() => setRegister(!chosen)}>
            {chosen ? '去登录' : '注册'}
          </Button>
        ) : null}
        {options.data?.registration === false ? <small>注册已关闭，请联系管理员</small> : null}
      </Card>
    </main>
  );
}
