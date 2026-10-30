import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
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
  const update = (patch: ToolSearch) =>
    void navigate({ replace: true, search: (previous) => ({ ...previous, ...patch }) });
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">TOOL CATALOG</span>
          <h1>工具目录</h1>
          <p>
            按连接和设备找到工具，以所选身份执行真实调用。切换工具或测试身份会取消未完成的请求。
          </p>
        </div>
      </div>
      <Feedback error={tools.error ?? connections.error ?? devices.error ?? profiles.error} />
      <ToolFilters
        values={filters}
        profiles={profiles.data ?? []}
        connections={connections.data ?? []}
        devices={devices.data ?? []}
        onChange={update}
      />
      <p role="status">
        {tools.isPending
          ? '正在读取工具目录…'
          : tools.isError
            ? '工具目录读取失败'
            : `显示 ${filtered.length} / ${tools.data.length} 个工具`}
      </p>
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
              <p>{tool.definition.description ?? '未提供描述'}</p>
            </Button>
          ))}
          {!filtered.length && tools.isSuccess ? (
            <Empty>
              {tools.data.length
                ? '没有匹配的工具，请调整连接、设备或搜索条件。'
                : profileId
                  ? '此 Agent 当前没有可用工具，请检查授权、身份凭证与目录发现状态。'
                  : '尚无工具，请先在 MCP 连接中发现目录。'}
            </Empty>
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
            <Empty>
              {filters.toolId
                ? '该工具不在当前身份与筛选范围内，请调整条件或重新选择。'
                : '选择一个工具，查看执行位置、参数并测试调用。'}
            </Empty>
          )}
        </Card>
      </div>
      <ContentCatalog key={profileId} connectionNames={connectionNames} profileId={profileId} />
    </>
  );
}
