import { toolAnnotations, toolSafety } from '@platform/contracts';
import {
  SafetyChoice,
  SafetyToolbar,
  useToolSelection,
} from '../../components/shared/ToolSafety.js';
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
  const selection = useToolSelection(selected);
  const labelled = tools.map((tool) => ({
    tool,
    id: tool.id,
    name: tool.name,
    safety: toolSafety(toolAnnotations(tool.definition)),
  }));
  const choices = (items: typeof labelled) =>
    items.map((item) => (
      <SafetyChoice key={item.id} tool={item} name="toolId" selection={selection}>
        <span>
          <strong>{item.name}</strong>
          <small>{connectionNames.get(item.tool.connectionId)}</small>
          {appInfo(item.tool) ? (
            <small>
              {appInfo(item.tool)?.resourceUri
                ? `App UI：${appInfo(item.tool)?.resourceUri} · `
                : ''}
              {appInfo(item.tool)?.visibility?.includes('app') &&
              !appInfo(item.tool)?.visibility?.includes('model')
                ? '仅 App 可用，不提供给模型'
                : '可供模型调用'}
            </small>
          ) : null}
        </span>
      </SafetyChoice>
    ));
  const focused = labelled.filter((item) => item.tool.connectionId === connectionId);
  const others = labelled.filter((item) => item.tool.connectionId !== connectionId);
  const focusedName = connectionNames.get(connectionId ?? '') ?? '所选连接';
  return (
    <fieldset>
      <legend>允许访问的工具</legend>
      {connectionId ? (
        <>
          <p className="text-sm text-muted-foreground">
            {creating && focused.length
              ? `已默认勾选「${focusedName}」的全部工具，可取消不需要的；仅勾选的工具会获授权。`
              : `优先展示「${focusedName}」的工具，仅勾选的工具会获授权。`}
          </p>
          <SafetyToolbar
            tools={focused}
            selection={selection}
            scope={`「${focusedName}」`}
            selectAllLabel="勾选这个连接的全部工具"
          />
          {choices(focused)}
          {!focused.length ? (
            <small>该连接还没有可用工具，请先完成授权并刷新工具列表。</small>
          ) : null}
          {others.length ? (
            <Disclosure title={`其他连接的工具（${others.length}）`}>{choices(others)}</Disclosure>
          ) : null}
        </>
      ) : (
        <>
          <SafetyToolbar tools={labelled} selection={selection} />
          {choices(labelled)}
        </>
      )}
      {!tools.length ? <small>先添加连接并刷新工具列表。</small> : null}
    </fieldset>
  );
}
