import { CheckChoice } from '../../components/shared/CheckChoice.js';
import type { ContentEntry, Tool } from '../../lib/api.js';

export function appInfo(tool: Tool) {
  return (
    tool.definition._meta as { ui?: { resourceUri?: string; visibility?: string[] } } | undefined
  )?.ui;
}

export function ContentGrants({
  entries,
  selected,
  connectionNames,
  tools,
}: {
  entries: ContentEntry[];
  selected: string[];
  connectionNames: Map<string, string>;
  tools: Tool[];
}) {
  const granted = new Set(selected);
  return (
    <fieldset>
      <legend>允许访问的提示词与资源</legend>
      {entries.map((entry) => (
        <CheckChoice
          key={entry.id}
          name="contentId"
          value={entry.id}
          defaultChecked={granted.has(entry.id)}
        >
          <span>
            <strong>{entry.name}</strong>
            <small>
              {entry.kind} · {connectionNames.get(entry.connectionId)}
            </small>
            {entry.locator.startsWith('ui://') ? (
              <small>
                App UI · 关联工具：
                {tools
                  .filter(
                    (tool) =>
                      tool.connectionId === entry.connectionId &&
                      appInfo(tool)?.resourceUri === entry.locator,
                  )
                  .map((tool) => tool.name)
                  .join('、') || '未声明'}
                。UI 资源和工具须分别勾选授权。
              </small>
            ) : null}
          </span>
        </CheckChoice>
      ))}
      {!entries.length ? (
        <small>连接 MCP 后会发现服务声明的提示词和资源。资源模板授权覆盖匹配该模板的 URI。</small>
      ) : null}
    </fieldset>
  );
}
