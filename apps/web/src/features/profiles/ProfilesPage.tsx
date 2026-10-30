import { PageHeader } from '../../components/shared/PageHeader.js';
import { DiscoveryEditor } from './DiscoveryEditor.js';
import { CatalogEditor } from './CatalogEditor.js';
import { WorkspacePage } from './WorkspacePage.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { useEffect, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Bot, ChevronRight, MoreHorizontal, Plus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu.js';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet.js';
import { api, type Tool, type Profile, type Connection, type ContentEntry } from '../../lib/api.js';
import { ProfilePermissionsEditor } from './ProfilePermissionsEditor.js';
import { ClientExportBody, type Export } from './ClientExport.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import {
  Action,
  Code,
  Empty,
  Feedback,
  Field,
  ListSkeleton,
} from '../../components/shared/Controls.js';

type Drawer =
  | { kind: 'create' }
  | { kind: 'edit'; profile: Profile }
  | { kind: 'access'; profile: Profile }
  | { kind: 'catalog'; profile: Profile }
  | { kind: 'discovery'; profile: Profile };

export default function ProfilesPage() {
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<Profile[]>('/profiles') });
  const tools = useQuery({ queryKey: ['tools'], queryFn: () => api<Tool[]>('/tools') });
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<ContentEntry[]>('/catalog'),
  });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<Connection[]>('/connections'),
  });
  const keys = useQuery({
    queryKey: ['keys'],
    queryFn: () => api<{ id: string; profileId: string; revoked: boolean }[]>('/profiles/keys/all'),
  });
  const { workspace } = useSearch({ from: '/profiles' });
  const navigate = useNavigate({ from: '/profiles' });
  const [drawer, setDrawer] = useState<Drawer>();
  const [key, setKey] = useState<{ exports?: Export[] }>();
  const editing = drawer?.kind === 'edit' ? drawer.profile : undefined;
  const close = () => setDrawer(undefined);
  useEffect(() => {
    // Onboarding links to #create-profile; open the drawer instead of scrolling to a form.
    if (window.location.hash === '#create-profile') setDrawer({ kind: 'create' });
  }, []);
  if (workspace)
    return <WorkspacePage profileId={workspace} onBack={() => void navigate({ search: {} })} />;
  const drawerProfile = drawer && 'profile' in drawer ? drawer.profile : undefined;
  return (
    <>
      <PageHeader
        title="Agent"
        actions={
          <Button onClick={() => setDrawer({ kind: 'create' })}>
            <Plus aria-hidden="true" />
            新建 Agent
          </Button>
        }
      />
      <Feedback
        error={profiles.error ?? tools.error ?? keys.error ?? connections.error ?? catalog.error}
      />
      <Card id="agent-configurations" className="panel scroll-mt-6">
        {profiles.isPending ? <ListSkeleton /> : null}
        {profiles.data?.length ? (
          profiles.data.map((profile) => {
            const activeKeys =
              keys.data?.filter((k) => k.profileId === profile.id && !k.revoked).length ?? 0;
            return (
              <div className="profile-row" key={profile.id}>
                <button
                  type="button"
                  className="profile-open"
                  onClick={() => void navigate({ search: { workspace: profile.id } })}
                >
                  <strong>{profile.name}</strong>
                  <small>
                    {profile.toolIds.length} 工具 · {profile.skillVersionIds.length} Skills ·{' '}
                    {activeKeys ? `${activeKeys} 个密钥` : '未生成密钥'}
                    {profile.deploymentState !== 'ready' ? ' · 配置模板待处理' : ''}
                  </small>
                  <ChevronRight size={16} aria-hidden="true" className="profile-chevron" />
                </button>
                <Button variant="outline" onClick={() => setDrawer({ kind: 'access', profile })}>
                  接入
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost" size="icon" />}
                    aria-label={`${profile.name} 更多操作`}
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-40">
                    <DropdownMenuItem onClick={() => setDrawer({ kind: 'edit', profile })}>
                      编辑权限
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setDrawer({ kind: 'catalog', profile })}>
                      目录展示
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setDrawer({ kind: 'discovery', profile })}>
                      智能发现
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => void navigate({ search: { workspace: profile.id } })}
                    >
                      打开工作空间
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })
        ) : profiles.isSuccess ? (
          <Empty
            icon={Bot}
            title="还没有 Agent"
            action={
              <Button variant="outline" onClick={() => setDrawer({ kind: 'create' })}>
                新建 Agent
              </Button>
            }
          >
            选择允许使用的工具，再生成客户端接入配置。
          </Empty>
        ) : null}
      </Card>
      <Sheet
        open={Boolean(drawer)}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>
              {drawer?.kind === 'create'
                ? '新建 Agent'
                : drawer?.kind === 'edit'
                  ? `编辑：${drawer.profile.name}`
                  : drawer?.kind === 'access'
                    ? `接入 ${drawer.profile.name}`
                    : drawer?.kind === 'catalog'
                      ? `目录展示 · ${drawer.profile.name}`
                      : drawer?.kind === 'discovery'
                        ? `智能发现 · ${drawer.profile.name}`
                        : ''}
            </SheetTitle>
            <SheetDescription>
              {drawer?.kind === 'create' || drawer?.kind === 'edit'
                ? '勾选允许这个 Agent 使用的工具和内容。'
                : drawer?.kind === 'access'
                  ? '复制配置到客户端；密钥只在生成时显示。'
                  : drawer?.kind === 'catalog'
                    ? '修改对外名称、描述和可选参数；授权仍关联原工具。'
                    : drawer?.kind === 'discovery'
                      ? '搜索模式只展示发现工具和钉选工具，不会唤醒休眠连接。'
                      : ''}
            </SheetDescription>
          </SheetHeader>
          {drawer?.kind === 'create' || drawer?.kind === 'edit' ? (
            <ProfilePermissionsEditor editing={editing} onSaved={close} />
          ) : null}
          {drawer?.kind === 'access' ? (
            <div className="grid gap-5">
              <Field label="MCP 地址">
                <Code value={`${window.location.origin}/mcp/${drawer.profile.id}`} />
              </Field>
              <ClientExportBody profileId={drawer.profile.id} />
              <section className="grid gap-2" aria-label="接入密钥">
                <h3>接入密钥</h3>
                {keys.data
                  ?.filter((k) => k.profileId === drawer.profile.id && !k.revoked)
                  .map((k) => (
                    <div className="row" key={k.id}>
                      <code className="grow">{k.id.slice(0, 8)}…</code>
                      <Action
                        danger
                        confirmation={{
                          title: `撤销密钥 ${k.id.slice(0, 8)}…？`,
                          description: '使用它的客户端会立即失效。',
                          confirmLabel: '撤销',
                        }}
                        action={() => api(`/profiles/keys/${k.id}`, { method: 'DELETE' })}
                      >
                        撤销密钥
                      </Action>
                    </div>
                  ))}
                <Action
                  variant="default"
                  action={async () =>
                    setKey(
                      await api<{ exports?: Export[] }>(`/profiles/${drawer.profile.id}/keys`, {
                        method: 'POST',
                      }),
                    )
                  }
                >
                  生成接入密钥
                </Action>
              </section>
            </div>
          ) : null}
          {drawer?.kind === 'catalog' && drawerProfile ? (
            <CatalogEditor
              key={drawerProfile.id}
              profile={drawerProfile}
              tools={tools.data ?? []}
              entries={catalog.data ?? []}
              connections={connections.data ?? []}
              close={close}
            />
          ) : null}
          {drawer?.kind === 'discovery' && drawerProfile ? (
            <DiscoveryEditor
              key={drawerProfile.id}
              profile={drawerProfile}
              tools={tools.data ?? []}
              close={close}
            />
          ) : null}
        </SheetContent>
      </Sheet>
      <Dialog
        open={Boolean(key)}
        onOpenChange={(open) => {
          if (!open) setKey(undefined);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>接入密钥已生成</DialogTitle>
            <DialogDescription>密钥只显示这一次。</DialogDescription>
          </DialogHeader>
          {key ? (
            <ol className="key-steps">
              <li>
                <h3>选择客户端并复制配置</h3>
                <ClientExportBody issued={key.exports} />
              </li>
              <li>
                <h3>粘贴到客户端的 MCP 设置后关闭</h3>
                <Button onClick={() => setKey(undefined)}>我已复制</Button>
              </li>
              <li>
                <Disclosure title="查看原始返回">
                  <Code value={key} />
                </Disclosure>
              </li>
            </ol>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
