import { PageHeader } from '../../components/shared/PageHeader.js';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Wrench } from 'lucide-react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Empty, Feedback, ListSkeleton } from '../../components/shared/Controls.js';
import { api, type Tool, type Connection, type Device, type Profile } from '../../lib/api.js';
import { ContentCatalog } from './ContentCatalog.js';
import { ToolFilters } from './ToolFilters.js';
import { ToolRunner } from './ToolRunner.js';
import { executionLocation, filterTools, identityLabel, type ToolSearch } from './toolCatalog.js';
export default function ToolsPage() {
  const filters = useSearch({ from: '/tools' });
  const navigate = useNavigate({ from: '/tools' });
  const { profileId } = filters;
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<Profile[]>('/profiles') });
  const tools = useQuery({
    queryKey: ['tools', profileId],
    queryFn: ({ signal }) =>
      profileId
        ? api<{ tools: Tool[] }>(`/profiles/${profileId}/agent/catalog`, { signal }).then(
            (catalog) => catalog.tools,
          )
        : api<Tool[]>('/tools', { signal }),
  });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<Connection[]>('/connections'),
  });
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => api<Device[]>('/devices'),
    refetchInterval: 15000,
  });
  const deviceById = new Map(devices.data?.map((device) => [device.id, device]));
  const connectionById = new Map(
    connections.data?.map((connection) => [connection.id, connection]),
  );
  const connectionNames = new Map(
    connections.data?.map((connection) => [
      connection.id,
      `${connection.name} · ${executionLocation(connection, deviceById)}`,
    ]),
  );
  const filtered = filterTools({
    tools: tools.data ?? [],
    connections: connections.data ?? [],
    devices: devices.data ?? [],
    filters,
  });
  const selected = filtered.find((tool) => tool.id === filters.toolId);
  const connection = selected ? connectionById.get(selected.connectionId) : undefined;
  const profile = profiles.data?.find((item) => item.id === profileId);
  const [view, setView] = useState<'tools' | 'content'>('tools');
  const update = (patch: ToolSearch) =>
    void navigate({ replace: true, search: (previous) => ({ ...previous, ...patch }) });
  return (
    <>
      <PageHeader title="工具" info="切换工具或测试身份会取消未完成的请求。" />
      <Feedback error={tools.error ?? connections.error ?? devices.error ?? profiles.error} />
      <ToolFilters
        values={filters}
        profiles={profiles.data ?? []}
        connections={connections.data ?? []}
        devices={devices.data ?? []}
        onChange={update}
      >
        <p role="status" className="filter-count">
          {tools.isPending ? (
            <span className="sr-only">正在读取工具目录</span>
          ) : tools.isError ? (
            '读取失败'
          ) : (
            <>
              <span className="sr-only">显示 </span>
              {filtered.length} / {tools.data.length}
              <span className="sr-only"> 个工具</span>
            </>
          )}
        </p>
      </ToolFilters>
      <div className="segmented" role="group" aria-label="目录类型">
        <Button
          size="sm"
          variant={view === 'tools' ? 'secondary' : 'ghost'}
          aria-pressed={view === 'tools'}
          onClick={() => setView('tools')}
        >
          工具
        </Button>
        <Button
          size="sm"
          variant={view === 'content' ? 'secondary' : 'ghost'}
          aria-pressed={view === 'content'}
          onClick={() => setView('content')}
        >
          Prompts 与 Resources
        </Button>
      </div>
      {view === 'content' ? (
        <ContentCatalog key={profileId} connectionNames={connectionNames} profileId={profileId} />
      ) : (
        <div className="tool-layout">
          <Card className="panel">
            {tools.isPending ? <ListSkeleton /> : null}
            {filtered.map((tool) => (
              <Button
                key={tool.id}
                className={`tool-option ${selected?.id === tool.id ? 'selected' : ''}`}
                aria-pressed={selected?.id === tool.id}
                onClick={() => update({ toolId: tool.id })}
              >
                <strong>{tool.name}</strong>
                <small>{connectionNames.get(tool.connectionId) ?? tool.connectionId}</small>
                {tool.definition.description ? (
                  <p title={tool.definition.description}>{tool.definition.description}</p>
                ) : null}
              </Button>
            ))}
            {!filtered.length && tools.isSuccess ? (
              <Empty
                icon={Wrench}
                variant={tools.data.length ? 'filtered' : 'default'}
                title={
                  tools.data.length
                    ? '没有匹配的工具'
                    : profileId
                      ? '这个 Agent 还没有可用工具'
                      : '还没有工具'
                }
                action={
                  tools.data.length ? (
                    <Button
                      variant="ghost"
                      onClick={() => update({ connectionId: '', deviceId: '', q: '' })}
                    >
                      清除筛选
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      render={<Link to={profileId ? '/profiles' : '/connections'} />}
                    >
                      {profileId ? '去授权' : '去添加连接'}
                    </Button>
                  )
                }
              />
            ) : null}
          </Card>
          <Card className="panel padded">
            {selected ? (
              <ToolRunner
                key={`${profileId ?? 'account'}:${selected.id}`}
                selected={selected}
                profileId={profileId}
                location={connectionNames.get(selected.connectionId) ?? selected.connectionId}
                identity={
                  !connection
                    ? '连接信息未读取'
                    : profileId && !profile
                      ? 'Agent 身份配置尚未读取'
                      : identityLabel(connection, profile)
                }
              />
            ) : (
              <Empty title={filters.toolId ? '该工具不在当前筛选范围内' : '选择左侧工具开始测试'} />
            )}
          </Card>
        </div>
      )}
    </>
  );
}
