import { CheckChoice } from '../../components/shared/CheckChoice.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import type { Tool } from '../../lib/api.js';
import { appInfo } from './ContentGrants.js';

export function ToolGrants({
  tools,
  selected,
  connectionNames,
  connectionId,
}: {
  tools: readonly Tool[];
  selected: readonly string[];
  connectionNames: ReadonlyMap<string, string>;
  connectionId?: string;
}) {
  const granted = new Set(selected);
  const choices = (items: readonly Tool[]) =>
    items.map((tool) => (
      <CheckChoice
        key={tool.id}
        name="toolId"
        value={tool.id}
        defaultChecked={granted.has(tool.id)}
      >
        <span>
          <strong>{tool.name}</strong>
          <small>{connectionNames.get(tool.connectionId)}</small>
          {appInfo(tool) ? (
            <small>
              {appInfo(tool)?.resourceUri ? `App UI：${appInfo(tool)?.resourceUri} · ` : ''}
              {appInfo(tool)?.visibility?.includes('app') &&
              !appInfo(tool)?.visibility?.includes('model')
                ? '仅 App 可用，不提供给模型'
                : '可供模型调用'}
            </small>
          ) : null}
        </span>
      </CheckChoice>
    ));
  const focused = tools.filter((tool) => tool.connectionId === connectionId);
  const others = tools.filter((tool) => tool.connectionId !== connectionId);
  return (
    <fieldset>
      <legend>允许访问的工具</legend>
      {connectionId ? (
        <>
          <p className="text-sm text-muted-foreground">
            优先展示「{connectionNames.get(connectionId) ?? connectionId}
            」的工具，仅勾选的工具会获授权。
          </p>
          {choices(focused)}
          {!focused.length ? (
            <small>该连接还没有可用工具，请先完成授权并连接读取目录。</small>
          ) : null}
          {others.length ? (
            <Disclosure title={`其他连接的工具（${others.length}）`}>{choices(others)}</Disclosure>
          ) : null}
        </>
      ) : (
        choices(tools)
      )}
      {!tools.length ? <small>先连接 MCP 并发现工具。</small> : null}
    </fieldset>
  );
}
