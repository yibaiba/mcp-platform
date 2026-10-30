import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
import { useState } from 'react';
import type { LocalRequest, LocalSource } from '@platform/contracts';
import type { Inventory } from './api.js';
export function Sources({
  state,
  busy,
  request,
}: {
  state: Inventory;
  busy: boolean;
  request: (input: LocalRequest) => Promise<unknown>;
}) {
  const [project, setProject] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [path, setPath] = useState('');
  const [kind, setKind] = useState<'mcp' | 'skill'>('mcp');
  const [client, setClient] = useState<LocalSource['client']>('cursor');
  return (
    <details className="local-sources">
      <summary>扫描来源与项目 · {state.sources.length}</summary>
      <p>用户级目录自动检查。项目和自定义目录由你指定；同名资源按真实位置区分。</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void request({ action: 'project.add', project });
        }}
      >
        <label>
          添加项目（绝对路径）
          <input
            required
            value={project}
            onChange={(e) => setProject(e.target.value)}
            placeholder="/absolute/project"
          />
        </label>
        <button disabled={busy}>添加项目</button>
      </form>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void request({
            action: 'source.add',
            source: {
              id: '',
              client,
              kind,
              path,
              format: path.endsWith('.toml') ? 'toml' : 'jsonc',
              pointer: [client === 'codex' ? 'mcp_servers' : 'mcpServers'],
              readOnly,
            },
          });
        }}
      >
        <label>
          客户端
          <SelectControl
            value={client}
            aria-label="客户端"
            onValueChange={(value) => setClient(value as LocalSource['client'])}
          >
            {[
              ['cursor', 'Cursor'],
              ['claude', 'Claude Code'],
              ['codex', 'Codex'],
              ['pi', 'Pi'],
            ].map(([id, title]) => (
              <SelectItem key={id} value={id}>
                {title}
              </SelectItem>
            ))}
          </SelectControl>
        </label>
        <label>
          资源类型
          <SelectControl
            aria-label="资源类型"
            value={kind}
            onValueChange={(value) => setKind(value as 'mcp' | 'skill')}
          >
            <SelectItem value="mcp">MCP 配置文件</SelectItem>
            <SelectItem value="skill">Skills 根目录</SelectItem>
          </SelectControl>
        </label>
        <label>
          自定义来源（绝对路径）
          <input value={path} onChange={(e) => setPath(e.target.value)} required />
        </label>
        <CheckChoice checked={readOnly} onCheckedChange={setReadOnly}>
          系统或供应商管理（只读）
        </CheckChoice>
        <button disabled={busy}>添加来源</button>
      </form>
      <ul>
        {state.sources.map((source) => (
          <li key={source.id}>
            <span>
              {source.client} · {source.kind} · {source.path}
              {source.project ? ` · ${source.project}` : ''}
            </span>
            <button
              disabled={busy}
              onClick={() => void request({ action: 'source.remove', id: source.id })}
            >
              移除来源
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
