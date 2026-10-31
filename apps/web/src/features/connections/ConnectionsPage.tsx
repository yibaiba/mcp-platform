import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { useEffect, useState } from 'react';
import { useDraftProtection } from '../../components/shared/useDraftProtection.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import type { ConnectorPreset, ConnectorAuthentication } from '@platform/contracts';
import { ArrowLeft, Inbox, Network, Plus, Search } from 'lucide-react';
import { PageHeader } from '../../components/shared/PageHeader.js';
import { ImportConnections } from './ImportConnections.js';
import { ConnectionSettings } from './ConnectionSettings.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet.js';
import { Tabs, TabsList, TabsPanel, TabsTab } from '../../components/ui/tabs.js';
import { api, type Connection, type Device } from '../../lib/api.js';
import { Input } from '../../components/ui/input.js';
import { Empty, Feedback, ListSkeleton } from '../../components/shared/Controls.js';
import { ConnectionForm } from './ConnectionForm.js';
import type { ConnectOutcome } from './connectNow.js';

const connectNotice = (outcome: ConnectOutcome): ConnectionNotice =>
  outcome.error
    ? { connectionId: outcome.connectionId, message: '已保存，未连接', error: outcome.error }
    : {
        connectionId: outcome.connectionId,
        message: `已保存并连接，读取到 ${outcome.tools ?? 0} 个工具`,
      };
import { ConnectorCatalog } from './ConnectorCatalog.js';
import { ConnectorForm } from './ConnectorForm.js';
import { ConnectionResult } from './ConnectionResult.js';
import { authorizeConnection } from './authorizationFlow.js';
import { authorizationResult } from './authorizationResult.js';
import {
  ConnectionItem,
  type ConnectionInspection,
  type ConnectionNotice,
} from './ConnectionItem.js';
import { ConnectionShares } from './ConnectionShares.js';
import { IncomingShares } from './IncomingShares.js';

type AddTab = 'catalog' | 'custom' | 'import';

/** One line when someone shared connections with you; the details open in a drawer. */
function SharedWithMe({ devices }: { devices: Device[] }) {
  const [open, setOpen] = useState(false);
  const shares = useQuery({
    queryKey: ['incoming-shares'],
    queryFn: () => api<{ id: string; status: string }[]>('/shares'),
  });
  if (!shares.data?.length) return null;
  const pending = shares.data.filter((share) => share.status === 'pending').length;
  return (
    <>
      <div className="shares-hint" role="status">
        <Inbox size={16} aria-hidden="true" />
        <span className="grow">
          {shares.data.length} 个共享给我的连接{pending ? `，${pending} 个待配置` : ''}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          查看
        </Button>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>共享给我的连接</SheetTitle>
            <SheetDescription>仅能使用所有者授权的工具和内容。</SheetDescription>
          </SheetHeader>
          <IncomingShares devices={devices} />
        </SheetContent>
      </Sheet>
    </>
  );
}

export default function ConnectionsPage() {
  const hash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate({ from: '/connections' });
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [location, setLocation] = useState('');
  const [editing, setEditing] = useState<Connection>();
  const [editingDirty, setEditingDirty] = useState(false);
  const protection = useDraftProtection(editingDirty);
  const [editAttempt, setEditAttempt] = useState<ConnectOutcome>();
  const closeEditor = () => {
    setEditing(undefined);
    setEditAttempt(undefined);
    setEditingDirty(false);
  };
  const [sharing, setSharing] = useState<Connection>();
  const [show, setShow] = useState(false);
  const [addTab, setAddTab] = useState<AddTab>('catalog');
  const [preset, setPreset] = useState<ConnectorPreset>();
  const [notice, setNotice] = useState<ConnectionNotice>();
  const [inspection, setInspection] = useState<ConnectionInspection>();
  const setResult = (result: unknown) => setInspection({ title: '连接设置结果', result });
  const queryClient = useQueryClient();
  const openAdd = (tab: AddTab = 'catalog') => {
    setPreset(undefined);
    setAddTab(tab);
    setShow(true);
  };
  useEffect(() => {
    // Onboarding links to #connector-catalog; open the add drawer instead of scrolling.
    if (hash !== 'connector-catalog') return;
    setPreset(undefined);
    setAddTab('catalog');
    setShow(true);
    void navigate({ hash: '', replace: true });
  }, [hash, navigate]);
  async function connectCreated(created: { id: string }, authentication: ConnectorAuthentication) {
    setShow(false);
    const say = (message: string, error: Error | null = null) =>
      setNotice({ connectionId: created.id, message, error });
    say(authentication === 'oauth' ? '正在准备授权…' : '正在连接…');
    try {
      if (authentication === 'oauth' && preset?.oauthRegistration) {
        setResult(await api(`/connections/${created.id}/oauth`));
        say('已保存。先把授权诊断中的回调地址登记到应用，再点「授权与账号」。');
        return;
      }
      const connected =
        authentication === 'oauth'
          ? await authorizeConnection({
              endpoint: `/connections/${created.id}/oauth`,
              request: api,
              navigate: (url) => window.location.assign(url),
            })
          : await api(`/connections/${created.id}/discover`, { method: 'POST' });
      say(
        authentication === 'oauth'
          ? authorizationResult(connected).url
            ? '正在前往授权页…'
            : '已授权'
          : '已连接',
      );
    } catch (error) {
      say('已保存，未连接', error instanceof Error ? error : new Error(String(error)));
    } finally {
      await queryClient.invalidateQueries();
    }
  }
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<Connection[]>('/connections'),
    select: (rows) => rows.filter((row) => row.source !== 'library'),
    refetchInterval: (query) =>
      query.state.data?.some((connection) => connection.health?.recover) ? 5000 : false,
  });
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<Device[]>('/devices') });
  const deviceById = new Map(devices.data?.map((device) => [device.id, device]));
  const filtered = connections.data?.filter((connection) => {
    const device = connection.deviceId ? deviceById.get(connection.deviceId)?.name : '';
    const text = [connection.name, connection.url, device, connection.transport]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase();
    return (
      text.includes(search.trim().toLocaleLowerCase()) &&
      (!status || connection.status === status) &&
      (!location ||
        (location === 'device'
          ? Boolean(connection.deviceId)
          : !connection.deviceId && connection.adapter === location))
    );
  });
  const clearFilters = () => {
    setSearch('');
    setStatus('');
    setLocation('');
  };
  return (
    <>
      <PageHeader
        title="连接"
        actions={
          <Button onClick={() => openAdd()}>
            <Plus aria-hidden="true" />
            添加连接
          </Button>
        }
      />
      <Feedback error={connections.error ?? devices.error} />
      <SharedWithMe devices={devices.data ?? []} />
      {connections.data?.length ? (
        <div className="connection-filters" role="search" aria-label="筛选连接">
          <div className="search-field">
            <Search size={14} aria-hidden="true" />
            <Input
              type="search"
              aria-label="搜索连接"
              value={search}
              placeholder="搜索名称、地址或设备"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <SelectControl aria-label="连接状态" value={status} onValueChange={setStatus}>
            <SelectItem value="">全部状态</SelectItem>
            <SelectItem value="connected">已连接</SelectItem>
            <SelectItem value="disconnected">待连接</SelectItem>
            <SelectItem value="stopped">已停止</SelectItem>
            <SelectItem value="error">连接错误</SelectItem>
            {Array.from(new Set(connections.data.map((connection) => connection.status)))
              .filter((value) => !['connected', 'disconnected', 'stopped', 'error'].includes(value))
              .map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
          </SelectControl>
          <SelectControl aria-label="运行位置" value={location} onValueChange={setLocation}>
            <SelectItem value="">全部位置</SelectItem>
            <SelectItem value="direct">平台服务器</SelectItem>
            <SelectItem value="pi">平台 Pi</SelectItem>
            <SelectItem value="device">设备</SelectItem>
          </SelectControl>
          <p role="status" className="filter-count">
            <span className="sr-only">显示 </span>
            {filtered?.length ?? 0} / {connections.data.length}
            <span className="sr-only"> 个连接</span>
          </p>
        </div>
      ) : null}
      <Card className="panel">
        {connections.data?.length && !filtered?.length ? (
          <Empty
            icon={Search}
            title="没有符合筛选条件的连接。"
            action={
              <Button variant="ghost" onClick={clearFilters}>
                清除筛选
              </Button>
            }
          />
        ) : null}
        {connections.data?.length ? (
          filtered?.map((connection) => (
            <ConnectionItem
              key={connection.id}
              connection={connection}
              devices={deviceById}
              notice={notice?.connectionId === connection.id ? notice : undefined}
              onNoticeDone={() => setNotice(undefined)}
              onShare={setSharing}
              onEdit={setEditing}
              onInspect={setInspection}
            />
          ))
        ) : connections.isPending ? (
          <ListSkeleton />
        ) : connections.isSuccess ? (
          <Empty icon={Network} title="还没有连接">
            点击右上角「添加连接」，选择内置服务、填写自定义服务，或导入配置。
          </Empty>
        ) : null}
      </Card>
      <Sheet open={show} onOpenChange={setShow}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{preset ? `添加 ${preset.name}` : '添加连接'}</SheetTitle>
            <SheetDescription>
              {preset ? '选择运行方式和认证信息，保存后自动连接。' : '选择服务来源。'}
            </SheetDescription>
          </SheetHeader>
          {preset ? (
            <div className="grid gap-4">
              <Button
                variant="ghost"
                size="sm"
                className="justify-self-start"
                onClick={() => setPreset(undefined)}
              >
                <ArrowLeft aria-hidden="true" />
                返回列表
              </Button>
              <ConnectorForm key={preset.id} preset={preset} onSaved={connectCreated} />
            </div>
          ) : (
            <Tabs value={addTab} onValueChange={(value) => setAddTab(value as AddTab)}>
              <TabsList aria-label="添加方式">
                <TabsTab value="catalog">内置</TabsTab>
                <TabsTab value="custom">自定义</TabsTab>
                <TabsTab value="import">导入</TabsTab>
              </TabsList>
              <TabsPanel value="catalog">
                <ConnectorCatalog
                  connections={connections.data ?? []}
                  onSelect={setPreset}
                  onManage={(connection) => {
                    setShow(false);
                    setEditing(connection);
                  }}
                />
              </TabsPanel>
              <TabsPanel value="custom">
                <ConnectionForm
                  devices={devices.data ?? []}
                  onConnected={(outcome) => {
                    setShow(false);
                    setNotice(connectNotice(outcome));
                  }}
                />
              </TabsPanel>
              <TabsPanel value="import" keepMounted>
                <ImportConnections
                  devices={devices.data ?? []}
                  connections={connections.data ?? []}
                />
              </TabsPanel>
            </Tabs>
          )}
        </SheetContent>
      </Sheet>
      <Dialog
        open={Boolean(inspection)}
        onOpenChange={(open) => {
          if (!open) setInspection(undefined);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{inspection?.title}</DialogTitle>
            <DialogDescription>本次操作的实际返回。</DialogDescription>
          </DialogHeader>
          {inspection ? <ConnectionResult result={inspection.result} /> : null}
        </DialogContent>
      </Dialog>
      <Sheet
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) protection.requestDiscard(closeEditor);
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>编辑连接</SheetTitle>
            <SheetDescription>
              正在编辑「{editing?.name}」。保存后结束现有会话，后续调用按新配置执行。
            </SheetDescription>
          </SheetHeader>
          {editing ? (
            <ConnectionSettings
              key={`${editing.id}:${editing.revision}`}
              connection={editing}
              lastAttempt={editAttempt}
              onDirtyChange={setEditingDirty}
              onSaved={async (outcome) => {
                if (!outcome.error) {
                  closeEditor();
                  setNotice(connectNotice(outcome));
                  return;
                }
                // Stay in the editor with the saved values so the address can be fixed again.
                const fresh = await api<Connection>(`/connections/${outcome.connectionId}`);
                setEditingDirty(false);
                setEditAttempt(outcome);
                setEditing(fresh);
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
      {protection.confirmation}
      <Sheet
        open={Boolean(sharing)}
        onOpenChange={(open) => {
          if (!open) setSharing(undefined);
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>共享 {sharing?.name}</SheetTitle>
            <SheetDescription>按接收账号授予能力，并选择凭证使用方式。</SheetDescription>
          </SheetHeader>
          {sharing && <ConnectionShares connectionId={sharing.id} />}
        </SheetContent>
      </Sheet>
      <p className="page-footnote">
        找不到需要的服务？去 <Link to="/market">市场</Link> 搜索。
      </p>
    </>
  );
}
