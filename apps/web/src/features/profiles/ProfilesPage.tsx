import { PageHeader } from '../../components/shared/PageHeader.js';
import { DiscoveryEditor } from './DiscoveryEditor.js';
import { CatalogEditor } from './CatalogEditor.js';
import { WorkspacePage } from './WorkspacePage.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
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
import { ClientExportBody } from './ClientExport.js';
import { ProfileAccess, type AccessKey, type IssuedAccess } from './ProfileAccess.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { Code, Empty, Feedback, ListSkeleton } from '../../components/shared/Controls.js';

type Drawer =
  | { kind: 'create' }
  | { kind: 'edit'; profile: Profile }
  | { kind: 'access'; profile: Profile; permissionsSaved?: boolean }
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
    queryFn: () => api<AccessKey[]>('/profiles/keys/all'),
  });
  const { workspace, connectionId } = useSearch({ from: '/profiles' });
  const hash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate({ from: '/profiles' });
  const [drawer, setDrawer] = useState<Drawer>();
  const [key, setKey] = useState<IssuedAccess>();
  const editing = drawer?.kind === 'edit' ? drawer.profile : undefined;
  const close = () => setDrawer(undefined);
  useEffect(() => {
    // Onboarding links to #create-profile; open the drawer instead of scrolling to a form.
    if (hash !== 'create-profile') return;
    setDrawer({ kind: 'create' });
    void navigate({ hash: '', replace: true, search: (previous) => previous });
  }, [hash, navigate]);
  if (workspace)
    return <WorkspacePage profileId={workspace} onBack={() => void navigate({ search: {} })} />;
  const drawerProfile = drawer && 'profile' in drawer ? drawer.profile : undefined;
  const source = connections.data?.find((connection) => connection.id === connectionId);
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
      {connectionId ? (
        <section className="mb-4 rounded-lg border bg-muted/30 p-4" aria-label="连接授权引导">
          <h2 className="text-sm font-medium">为「{source?.name ?? '所选连接'}」分配权限</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            选择下方已有 Agent 分配权限，或新建 Agent。保存后可直接获取客户端接入配置。
          </p>
          {connections.isSuccess && !source ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              来源连接已不可用，请确认连接是否仍存在或仍获共享授权。
            </p>
          ) : null}
        </section>
      ) : null}
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
                    {keys.isPending
                      ? '密钥加载中'
                      : keys.isError
                        ? '密钥读取失败'
                        : activeKeys
                          ? `${activeKeys} 个密钥`
                          : '未生成密钥'}
                    {profile.deploymentState !== 'ready' ? ' · 配置模板待处理' : ''}
                  </small>
                  <ChevronRight size={16} aria-hidden="true" className="profile-chevron" />
                </button>
                <Button
                  variant="outline"
                  onClick={() => setDrawer({ kind: connectionId ? 'edit' : 'access', profile })}
                >
                  {connectionId ? '分配权限' : '接入'}
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
            <ProfilePermissionsEditor
              key={editing?.id ?? 'new'}
              editing={editing}
              connectionId={connectionId}
              onSaved={(profile) => setDrawer({ kind: 'access', profile, permissionsSaved: true })}
            />
          ) : null}
          {drawer?.kind === 'access' ? (
            <ProfileAccess
              profile={drawer.profile}
              connectionId={connectionId}
              permissionsSaved={drawer.permissionsSaved}
              onIssued={setKey}
            />
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
            <DialogDescription>
              密钥只显示这一次。复制后请在客户端确认工具列表。
              {key?.revoked?.length ? `已撤销这个 Agent 的 ${key.revoked.length} 把旧密钥。` : ''}
            </DialogDescription>
          </DialogHeader>
          {key ? (
            <ol className="key-steps">
              <li>
                <h3>选择客户端并复制配置</h3>
                <ClientExportBody issued={key.exports} />
              </li>
              <li>
                <h3>粘贴到客户端的 MCP 设置后关闭</h3>
                <Button onClick={() => setKey(undefined)}>关闭密钥窗口</Button>
              </li>
              <li>
                <Link
                  to="/tools"
                  search={{ profileId: key.profileId, connectionId }}
                  onClick={() => {
                    setKey(undefined);
                    close();
                  }}
                  className="inline-flex min-h-11 items-center text-primary hover:underline"
                >
                  以此 Agent 测试工具
                </Link>
                <p className="text-sm text-muted-foreground">
                  测试只在你选择工具并点击执行后开始。
                </p>
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
