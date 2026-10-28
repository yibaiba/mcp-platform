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
  providers: { id: string; name: string; kind: string }[];
};
export function AuthScreen() {
  const [register, setRegister] = useState(false);
  const options = useQuery({
    queryKey: ['login-options'],
    queryFn: () => api<LoginOptions>('/login-options'),
  });
  return (
    <main className="auth-screen">
      <div className="auth-brand">
        <Network size={32} />
        <span>
          MCP <b>Platform</b>
        </span>
      </div>
      <Card className="auth-card">
        <span className="eyebrow">YOUR TOOLS, CONNECTED.</span>
        <h1>{register ? '创建你的工作空间' : '欢迎回来'}</h1>
        <p>让工具跨越设备，让任务专注于结果。</p>
        <Form
          label={register ? '创建账户' : '登录平台'}
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
                  ? await authClient.signIn.oauth2({ providerId: provider.id, callbackURL: '/' })
                  : await authClient.signIn.social({ provider: provider.id, callbackURL: '/' });
              if (result.error) throw new Error(result.error.message ?? '单点登录失败');
            }}
          >
            使用 {provider.name} 登录
          </Action>
        ))}
        {options.data?.registration ? (
          <Button variant="ghost" onClick={() => setRegister(!register)}>
            {register ? '已有账户，返回登录' : '首次使用？创建账户'}
          </Button>
        ) : null}
        <small>自托管部署默认关闭注册，由管理员在首次设置时启用。</small>
      </Card>
    </main>
  );
}
