import { PageHeader } from '../../components/shared/PageHeader.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Plus } from 'lucide-react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { ConfirmDialog } from '../../components/shared/ConfirmDialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { useState } from 'react';
import { api, isForbidden } from '../../lib/api.js';
import { Input } from '../../components/ui/input.js';
import { Card } from '../../components/ui/card.js';
import {
  Feedback,
  Field,
  Forbidden,
  Form,
  InlineStatus,
  ListSkeleton,
  QueryError,
  value,
} from '../../components/shared/Controls.js';
import { SelectItem } from '../../components/ui/select.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
type User = { id: string; name: string; email: string; role: 'admin' | 'member'; enabled: boolean };

function UserEditor({ user, onSaved }: { user?: User; onSaved: () => void }) {
  const [role, setRole] = useState(user?.role ?? 'member');
  return (
    <Form
      label={user ? '保存账号' : '创建账号'}
      submit={async (data) => {
        await api(user ? `/admin/users/${encodeURIComponent(user.id)}` : '/admin/users', {
          method: user ? 'PATCH' : 'POST',
          body: JSON.stringify({
            name: value(data, 'name'),
            email: value(data, 'email'),
            role,
            ...(!user ? { enabled: true } : {}),
            ...(!user ? { password: value(data, 'password') } : {}),
          }),
        });
        onSaved();
      }}
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

type Pending = { kind: 'toggle' | 'sessions'; user: User };

export default function UsersPage() {
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => api<User[]>('/admin/users') });
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<User | 'new'>();
  const [pending, setPending] = useState<Pending>();
  const [actionError, setActionError] = useState<Error | null>(null);
  const [done, setDone] = useState('');
  if (isForbidden(users.error)) return <Forbidden />;
  const run = (target: Pending) => {
    setPending(undefined);
    setActionError(null);
    const id = encodeURIComponent(target.user.id);
    const request =
      target.kind === 'toggle'
        ? api(`/admin/users/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: !target.user.enabled }),
          })
        : api(`/admin/users/${id}/sessions`, { method: 'DELETE' });
    void request
      .then(() =>
        setDone(
          target.kind === 'sessions' ? '已退出全部会话' : target.user.enabled ? '已停用' : '已启用',
        ),
      )
      .catch((error: unknown) =>
        setActionError(error instanceof Error ? error : new Error(String(error))),
      )
      .finally(() => void queryClient.invalidateQueries({ queryKey: ['admin-users'] }));
  };
  return (
    <>
      <PageHeader
        title="用户管理"
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus aria-hidden="true" />
            新建用户
          </Button>
        }
      />
      <QueryError error={users.error} onRetry={() => users.refetch()} />
      <Feedback error={actionError} />
      {done ? (
        <p>
          <InlineStatus onDone={() => setDone('')}>{done}</InlineStatus>
        </p>
      ) : null}
      <Card className="panel">
        {users.isPending ? <ListSkeleton /> : null}
        {users.data?.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>姓名</TableHead>
                <TableHead>邮箱</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.name}</TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground">
                    {user.email}
                  </TableCell>
                  <TableCell>{user.role === 'admin' ? '管理员' : '普通用户'}</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={`status status-${user.enabled ? 'online' : 'stopped'}`}
                    >
                      <i aria-hidden="true" />
                      {user.enabled ? '启用' : '停用'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(user)}>
                      编辑
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon-sm" />}
                        aria-label={`${user.name} 更多操作`}
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-44">
                        <DropdownMenuItem
                          variant={user.enabled ? 'destructive' : 'default'}
                          onClick={() =>
                            user.enabled
                              ? setPending({ kind: 'toggle', user })
                              : run({ kind: 'toggle', user })
                          }
                        >
                          {user.enabled ? '停用账号' : '启用账号'}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setPending({ kind: 'sessions', user })}
                        >
                          撤销全部登录会话
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </Card>
      <Sheet
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>
              {editing === 'new' ? '新建用户' : `编辑 ${editing?.name ?? ''}`}
            </SheetTitle>
            <SheetDescription>
              {editing === 'new' ? '新用户首次登录使用初始密码。' : '修改姓名、邮箱或角色。'}
            </SheetDescription>
          </SheetHeader>
          {editing ? (
            <UserEditor
              key={editing === 'new' ? 'new' : editing.id}
              user={editing === 'new' ? undefined : editing}
              onSaved={() => {
                setDone(editing === 'new' ? '已创建' : '已保存');
                setEditing(undefined);
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={Boolean(pending)}
        onOpenChange={(open) => {
          if (!open) setPending(undefined);
        }}
        danger
        title={
          pending?.kind === 'sessions'
            ? `让「${pending.user.name}」在所有设备上退出登录？`
            : `停用「${pending?.user.name ?? ''}」？`
        }
        description={
          pending?.kind === 'sessions'
            ? '该账号的全部登录会话会立即失效。'
            : '将撤销其 Agent 凭证并终止活跃调用，重新启用后需重新签发。'
        }
        confirmLabel={pending?.kind === 'sessions' ? '退出全部会话' : '停用'}
        onConfirm={() => {
          if (pending) run(pending);
        }}
      />
    </>
  );
}
