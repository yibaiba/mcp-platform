import { useState } from 'react';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
import { Button } from '../../components/ui/button.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import type { Tool } from '../../lib/api.js';
import { appInfo } from './ContentGrants.js';

export function ToolGrants({
  tools,
  selected,
  connectionNames,
  connectionId,
  creating,
}: {
  tools: readonly Tool[];
  selected: readonly string[];
  connectionNames: ReadonlyMap<string, string>;
  connectionId?: string;
  /** A new Agent: the focused connection's tools arrive already checked. */
  creating?: boolean;
}) {
  // "勾选全部" remounts the checkboxes with the connection's tools added (they are uncontrolled).
  const [added, setAdded] = useState<readonly string[]>([]);
  const granted = new Set([...selected, ...added]);
  const choices = (items: readonly Tool[]) =>
    items.map((tool) => (
      <CheckChoice
        key={added.includes(tool.id) ? `${tool.id}:all` : tool.id}
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
            {creating && focused.length
              ? `已默认勾选「${connectionNames.get(connectionId) ?? '所选连接'}」的全部工具，可取消不需要的；仅勾选的工具会获授权。`
              : `优先展示「${connectionNames.get(connectionId) ?? '所选连接'}」的工具，仅勾选的工具会获授权。`}
          </p>
          {!creating && focused.some((tool) => !granted.has(tool.id)) ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setAdded(focused.map((tool) => tool.id))}
            >
              勾选这个连接的全部工具
            </Button>
          ) : null}
          {choices(focused)}
          {!focused.length ? (
            <small>该连接还没有可用工具，请先完成授权并刷新工具列表。</small>
          ) : null}
          {others.length ? (
            <Disclosure title={`其他连接的工具（${others.length}）`}>{choices(others)}</Disclosure>
          ) : null}
        </>
      ) : (
        choices(tools)
      )}
      {!tools.length ? <small>先添加连接并刷新工具列表。</small> : null}
    </fieldset>
  );
}
