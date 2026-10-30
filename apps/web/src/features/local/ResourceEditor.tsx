import { useState } from 'react';
import type { LocalBinding, LocalRequest, LocalResource } from '@platform/contracts';
import type { ManagementApi } from './api.js';
import { SkillVersions } from './SkillVersions.js';
import { SkillEditor } from './SkillEditor.js';
export function ResourceEditor({
  resource,
  current,
  binding,
  api,
  busy,
  request,
  act,
  reload,
}: {
  resource: LocalResource;
  current?: LocalResource;
  binding?: LocalBinding;
  api: ManagementApi;
  busy: boolean;
  request: (input: LocalRequest) => Promise<unknown>;
  act: (work: () => Promise<unknown>) => Promise<void>;
  reload: () => void;
}) {
  const latest = current ?? resource;
  const [text, setText] = useState(() =>
    JSON.stringify(api.remote && binding ? binding.content : resource.content, null, 2),
  );
  const [deleting, setDeleting] = useState(false);
  const [baselineDigest, setBaselineDigest] = useState(resource.digest);
  const [identity, setIdentity] = useState('');
  const [files, setFiles] = useState(
    () => (api.remote && binding ? binding.content : resource.content) as Record<string, string>,
  );
  const content = () => (resource.kind === 'skill' ? files : JSON.parse(text));
  const save = () =>
    act(async () => {
      const value = content();
      if (api.remote && binding && api.binding)
        return api.binding(binding, { action: 'update', content: value });
      const result = (await request({
        action: 'edit',
        id: resource.id,
        expectedDigest: baselineDigest,
        content: value,
      })) as { result?: { digest?: string } };
      if (result.result?.digest) setBaselineDigest(result.result.digest);
      return result;
    });
  const resolve = (choice: string) =>
    act(() => api.binding!(binding!, { action: 'resolve', choice, content: content() }));
  return (
    <aside className="local-editor" aria-label={`${resource.name} 详情`}>
      <h2>{resource.name}</h2>
      <p className="local-path">{resource.realPath}</p>
      {current?.digest !== baselineDigest ? (
        <p className="local-error">
          来源已变化，当前编辑内容保留。<button onClick={reload}>重新载入来源</button>
        </p>
      ) : null}
      <p className="local-note">配置写入后需要客户端重新加载。Agent 授权请在 Agent 页管理。</p>
      {resource.kind === 'skill' ? (
        <>
          <SkillEditor files={files ?? {}} onChange={setFiles} readOnly={latest.readOnly} />
          <SkillVersions resource={resource} api={api} busy={busy} act={act} onChange={setFiles} />
          {api.remote && !latest.selected ? <p>纳入同步后可查看和编辑 Skill 文件。</p> : null}
        </>
      ) : (
        <label>
          所选 MCP 条目（JSON）
          <textarea
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
            readOnly={latest.readOnly}
            rows={16}
          />
        </label>
      )}
      <div className="local-actions">
        <button
          disabled={busy || latest.readOnly || (api.remote && !binding)}
          onClick={() => void save()}
        >
          保存修改
        </button>
        {resource.kind === 'mcp' ? (
          <>
            <button
              disabled={busy || latest.readOnly || latest.deleted}
              onClick={() => void act(() => request({ action: 'start', id: resource.id }))}
            >
              由连接器连接
            </button>
            <button
              disabled={busy || latest.runtime === 'client-managed'}
              onClick={() => void act(() => request({ action: 'stop', id: resource.id }))}
            >
              停止连接器会话
            </button>
          </>
        ) : null}
      </div>
      {binding && api.binding ? (
        <section className="local-conflict">
          <h3>同步副本 · 修订 {binding.revision}</h3>
          {binding.error ? (
            <p role="alert" className="local-error">
              {binding.error}
            </p>
          ) : null}
          <details open={binding.status === 'conflict'}>
            <summary>比较共同基线、本机与平台</summary>
            <div className="local-diff">
              {[
                ['共同基线', binding.baseline],
                ['本机', binding.localContent],
                ['平台', binding.content],
              ].map(([label, value]) => (
                <section key={String(label)}>
                  <h4>{String(label)}</h4>
                  <pre>{JSON.stringify(value, null, 2)}</pre>
                </section>
              ))}
            </div>
          </details>
          {binding.status === 'conflict' || binding.status === 'deletion_pending' ? (
            <div className="local-actions">
              <button disabled={busy} onClick={() => void resolve('local')}>
                采用本机
              </button>
              <button disabled={busy} onClick={() => void resolve('platform')}>
                采用平台
              </button>
              <button disabled={busy} onClick={() => void resolve('merge')}>
                采用编辑后的合并
              </button>
            </div>
          ) : null}
          <button
            disabled={busy}
            onClick={() => void act(() => api.binding!(binding, { action: 'unlink' }))}
          >
            解除同步，保留两侧内容
          </button>
        </section>
      ) : null}
      {!api.remote && resource.kind === 'mcp' ? (
        <details className="local-conflict">
          <summary>独立身份的本机凭证绑定</summary>
          <p>将平台授权绑定 ID 显式关联到当前资源。没有绑定时会报错，不会继承共享账号。</p>
          <label>
            授权绑定 ID
            <input value={identity} onChange={(e) => setIdentity(e.target.value)} />
          </label>
          <button
            disabled={busy || !latest.selected || !identity}
            onClick={() =>
              void act(() => request({ action: 'identity.bind', id: resource.id, identity }))
            }
          >
            绑定当前本机资源
          </button>
        </details>
      ) : null}
      {!latest.readOnly ? (
        <div className="local-danger">
          {deleting ? (
            <>
              <p>确认删除所选条目？传播删除前保存本机恢复副本。</p>
              <button
                disabled={busy}
                onClick={() =>
                  void (api.remote && binding && api.binding
                    ? act(() => api.binding!(binding, { action: 'delete', confirm: true }))
                    : act(() =>
                        request({
                          action: 'delete',
                          id: resource.id,
                          expectedDigest: baselineDigest,
                          confirm: true,
                        }),
                      ))
                }
              >
                确认删除
              </button>
              <button onClick={() => setDeleting(false)}>取消</button>
            </>
          ) : (
            <button onClick={() => setDeleting(true)}>删除资源…</button>
          )}
        </div>
      ) : null}
    </aside>
  );
}
