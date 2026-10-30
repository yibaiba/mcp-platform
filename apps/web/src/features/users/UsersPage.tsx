import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, isForbidden } from '../../lib/api.js';
import { Input } from '../../components/ui/input.js';
import { Card } from '../../components/ui/card.js';
import {
  Action,
  Field,
  Forbidden,
  Form,
  QueryError,
  value,
} from '../../components/shared/Controls.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { SelectItem } from '../../components/ui/select.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
type User = { id: string; name: string; email: string; role: 'admin' | 'member'; enabled: boolean };

function UserEditor({ user }: { user?: User }) {
  const [role, setRole] = useState(user?.role ?? 'member');
  return (
    <Form
      label={user ? '保存账号' : '创建账号'}
      submit={(data) =>
        api(user ? `/admin/users/${encodeURIComponent(user.id)}` : '/admin/users', {
          method: user ? 'PATCH' : 'POST',
          body: JSON.stringify({
            name: value(data, 'name'),
            email: value(data, 'email'),
            role,
            ...(!user ? { enabled: true } : {}),
            ...(!user ? { password: value(data, 'password') } : {}),
          }),
        })
      }
    >
      <Field label="姓名">
        <Input name="name" defaultValue={user?.name} required />
      </Field>
      <Field label="邮箱">
        <Input name="email" type="email" defaultValue={user?.email} required />
      </Field>
      <Field label="角色">
        <SelectControl value={role} onValueChange={(value) => setRole(value as User['role'])}>
          <SelectItem value="member">普通用户</SelectItem>
          <SelectItem value="admin">管理员</SelectItem>
        </SelectControl>
      </Field>
      {!user ? (
        <Field label="初始密码">
          <Input
            type="password"
            name="password"
            minLength={8}
            maxLength={128}
            autoComplete="new-password"
            required
          />
        </Field>
      ) : null}
    </Form>
  );
}

export default function UsersPage() {
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => api<User[]>('/admin/users') });
  if (isForbidden(users.error)) return <Forbidden />;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>用户管理</h1>
          <p>
            每个用户保留个人空间。停用会撤销 Agent 凭证并终止活跃调用；重新启用后需重新签发凭证。
          </p>
        </div>
      </div>
      <QueryError error={users.error} onRetry={() => users.refetch()} />
      <Card className="panel padded">
        <h2>创建用户</h2>
        <Disclosure title="填写新用户信息">
          <UserEditor />
        </Disclosure>
      </Card>
      {users.data?.map((user) => (
        <Card className="panel padded" key={user.id}>
          <h2>
            {user.name} · {user.enabled ? '启用' : '停用'}
          </h2>
          <p className="break-all text-muted-foreground">
            {user.email} · {user.role === 'admin' ? '管理员' : '普通用户'}
          </p>
          <Disclosure title="编辑账号">
            <UserEditor user={user} />
          </Disclosure>
          <div className="my-4 flex flex-wrap items-center gap-3">
            <Action
              danger={user.enabled}
              confirmation={
                user.enabled
                  ? {
                      title: `停用「${user.name}」？`,
                      description: '将撤销其 Agent 凭证并终止活跃调用，重新启用后需重新签发。',
                      confirmLabel: '停用',
                    }
                  : undefined
              }
              action={() =>
                api(`/admin/users/${encodeURIComponent(user.id)}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ enabled: !user.enabled }),
                })
              }
            >
              {user.enabled ? '停用账号' : '启用账号'}
            </Action>
            <Action
              danger
              confirmation={{
                title: `让「${user.name}」在所有设备上退出登录？`,
                description: '该账号的全部登录会话会立即失效。',
                confirmLabel: '退出全部会话',
              }}
              action={() =>
                api(`/admin/users/${encodeURIComponent(user.id)}/sessions`, { method: 'DELETE' })
              }
            >
              撤销全部登录会话
            </Action>
          </div>
        </Card>
      ))}
    </>
  );
}
