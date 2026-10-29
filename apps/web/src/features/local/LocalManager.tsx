import { LocalNetwork } from '../network/LocalNetwork.js';
import { useCallback, useEffect, useState } from 'react';
import type { LocalRequest, LocalResource } from '@platform/contracts';
import type { Inventory, ManagementApi } from './api.js';
import { ResourceEditor } from './ResourceEditor.js';
import { Sources } from './Sources.js';
import './local.css';
export const labels: Record<string, string> = {
  synced: '已同步',
  pending: '待同步',
  conflict: '双方修改冲突',
  deletion_pending: '删除待确认',
  deleted: '已删除',
  unlinked: '已解除同步',
  succeeded: '成功',
  failed: '失败',
  running: '执行中',
  prepared: '写入待核对',
  interrupted: '已中断',
  error: '错误',
  'client-managed': '由客户端管理',
  connected: '连接成功',
};
export function LocalManager({ api }: { api: ManagementApi }) {
  const [state, setState] = useState<Inventory>();
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('mcp');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<LocalResource>();
  const refresh = useCallback(async () => {
    try {
      setState(await api.load());
      setLoadError('');
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const request = (input: LocalRequest) =>
    api.request({ expectedRevision: state?.revision, operationId: crypto.randomUUID(), ...input });
  const bindings = new Map(state?.bindings?.map((binding) => [binding.resourceId, binding]));
  const resources = Object.values(state?.resources ?? {}).filter(
    (r) =>
      r.kind === tab &&
      `${r.name} ${r.description} ${r.clients.join(' ')} ${r.project ?? ''} ${r.realPath} ${labels[bindings.get(r.id)?.status ?? ''] ?? ''} ${r.runtime} ${labels[r.runtime] ?? ''} ${r.selected ? '已纳管' : '未纳管'} ${r.readOnly ? '只读' : ''} ${r.deleted ? '已删除' : '发现配置'} ${r.reloadRequired ? '客户端待重新加载' : ''} ${bindings.get(r.id)?.authorizedProfiles?.join(' ') ?? ''}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  return (
    <section className="local-manager" aria-label="资源管理">
      <div className="local-toolbar">
        <div className="local-tabs" role="tablist" aria-label="资源视图">
          {[
            ['mcp', 'MCP'],
            ['skill', 'Skills'],
            ['history', '同步记录'],
            ...(!api.remote ? [['network', '网络与安装源']] : []),
          ].map(([id, label]) => (
            <button role="tab" aria-selected={tab === id} key={id} onClick={() => setTab(id!)}>
              {label}
            </button>
          ))}
        </div>
        <div className="local-actions">
          <button
            disabled={busy || !state}
            onClick={() => void act(() => request({ action: 'scan' }))}
          >
            重新扫描
          </button>
          {api.sync ? (
            <button disabled={busy} onClick={() => void act(api.sync!)}>
              核对同步
            </button>
          ) : null}
        </div>
      </div>
      <p className="local-note">
        {api.remote
          ? '配置中的 local:// 字段由目标设备解析。凭证请在本机页编辑。'
          : '扫描不会运行命令或 Skill 脚本。固定凭证留在本机，纳管不会授予 Agent 权限。'}
      </p>
      {error || loadError ? (
        <p className="local-error" role="alert">
          {error || loadError}
        </p>
      ) : null}
      {!state ? (
        <p role="status">正在读取资源…</p>
      ) : (
        <>
          {state.issues.map((issue, i) => (
            <p className="local-error" key={i}>
              {issue}
            </p>
          ))}
          <Sources state={state} busy={busy} request={(input) => act(() => request(input))} />
          {tab === 'network' && !api.remote ? (
            <LocalNetwork api={api} />
          ) : tab === 'history' ? (
            <div className="local-history">
              {[...Object.values(state.operations), ...(state.platformOperations ?? [])]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((op) => (
                  <article key={op.id}>
                    <strong>{op.action}</strong> <span>{labels[op.phase] ?? op.phase}</span>
                    <small>{new Date(op.createdAt).toLocaleString()}</small>
                    {op.error ? <p role="alert">{op.error}</p> : null}
                    {'backup' in op && op.backup && op.resourceId ? (
                      <button
                        disabled={busy}
                        onClick={() => {
                          const resource = state.resources[op.resourceId!];
                          if (resource)
                            void act(() =>
                              request({
                                action: 'restore',
                                id: resource.id,
                                expectedDigest: resource.digest,
                                content: { operationId: op.id },
                                confirm: true,
                              }),
                            );
                        }}
                      >
                        恢复此修改前的副本
                      </button>
                    ) : null}
                  </article>
                ))}
              {!Object.keys(state.operations).length && !state.platformOperations?.length ? (
                <p>暂无操作记录。扫描、编辑和同步会在这里留下结果。</p>
              ) : null}
            </div>
          ) : (
            <>
              <label className="local-search">
                搜索资源
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="名称、说明、客户端、项目或状态"
                />
              </label>
              <div className="local-columns">
                <div className="local-list" aria-label="资源列表">
                  {resources.map((resource) => (
                    <article
                      key={resource.id}
                      className={
                        selected?.id === resource.id ? 'local-resource active' : 'local-resource'
                      }
                    >
                      <button
                        className="local-resource-title"
                        onClick={() => setSelected(resource)}
                      >
                        <strong>{resource.name}</strong>
                        <span>{resource.description || '未提供说明'}</span>
                      </button>
                      <small>
                        {resource.clients.join(' · ')} · {resource.project ?? '用户级'}
                        {resource.path !== resource.realPath ? ` → ${resource.realPath}` : ''}
                      </small>
                      <div className="local-statuses">
                        <span>{resource.deleted ? '已从本机删除' : '发现配置'}</span>
                        {resource.kind === 'mcp' ? (
                          <>
                            <span>
                              {resource.programExists ? '启动程序存在' : '启动程序未验证'}
                            </span>
                            <span>{labels[resource.runtime] ?? resource.runtime}</span>
                          </>
                        ) : null}
                        {bindings.get(resource.id) ? (
                          <span>
                            {labels[bindings.get(resource.id)!.status] ??
                              bindings.get(resource.id)!.status}
                          </span>
                        ) : null}
                        <span>
                          {bindings.get(resource.id)?.authorizedProfiles?.length
                            ? `Agent 已授权：${bindings.get(resource.id)!.authorizedProfiles!.join('、')}`
                            : api.remote
                              ? resource.kind === 'skill'
                                ? 'Agent 未授权当前版本'
                                : 'Agent 尚未授权'
                              : 'Agent 授权由平台核对'}
                        </span>
                        {resource.reloadRequired ? <span>客户端待重新加载</span> : null}
                        {resource.readOnly ? <span>只读</span> : null}
                      </div>
                      <label className="local-select">
                        <input
                          type="checkbox"
                          checked={resource.selected}
                          disabled={busy || resource.readOnly || resource.deleted}
                          onChange={(e) =>
                            void act(() =>
                              request({
                                action: 'select',
                                id: resource.id,
                                selected: e.target.checked,
                              }),
                            )
                          }
                        />
                        纳入此设备与来源同步
                      </label>
                      {resource.issues.map((issue) => (
                        <p className="local-error" key={issue}>
                          {issue}
                        </p>
                      ))}
                    </article>
                  ))}
                  {!resources.length ? (
                    <p className="local-empty">
                      没有匹配资源。可添加项目或配置目录，然后重新扫描。
                    </p>
                  ) : null}
                </div>
                {selected ? (
                  <ResourceEditor
                    key={selected.id + selected.digest}
                    resource={selected}
                    current={state.resources[selected.id]}
                    binding={bindings.get(selected.id)}
                    api={api}
                    busy={busy}
                    request={request}
                    act={act}
                    reload={() => setSelected(state.resources[selected.id])}
                  />
                ) : (
                  <aside className="local-empty">选择资源，查看配置、文件和同步差异。</aside>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
