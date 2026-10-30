import { useState } from 'react';
import {
  TOOL_PREFIX_MAX,
  connectionToolPrefix,
  nameNeedsToolPrefix,
  suggestToolPrefix,
  toolPrefix as toolPrefixSchema,
} from '@platform/contracts';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Field } from '../../components/shared/Controls.js';

/**
 * "英文标识（工具名前缀）": the connection part of tool names clients see (`prefix__tool`).
 * Empty keeps the name-derived prefix, so existing tool names never change unless the user sets it.
 */
export function ToolPrefixField({
  source,
  connectionId,
  initial,
}: {
  /** What the suggestion and the "名称是中文" prompt are based on (live while creating). */
  source: { name: string; url?: string; command?: string; args?: readonly string[] };
  /** Set when editing: the current prefix is previewed and changing it is flagged. */
  connectionId?: string;
  initial?: string | null;
}) {
  const [prefix, setPrefix] = useState(initial ?? '');
  const suggestion = suggestToolPrefix(source);
  const typed = prefix.trim();
  const invalid = typed ? toolPrefixSchema.safeParse(typed).error?.issues[0]?.message : undefined;
  const current = connectionId
    ? connectionToolPrefix(connectionId, source.name, initial)
    : undefined;
  const effective =
    typed && !invalid
      ? typed
      : connectionId
        ? connectionToolPrefix(connectionId, source.name)
        : undefined;
  const needsPrefix = !typed && nameNeedsToolPrefix(source.name);
  return (
    <div className="space-y-1.5">
      <Field
        label="英文标识（工具名前缀，可选）"
        hint={`客户端里的工具名是「英文标识__工具名」。小写字母、数字、_ 或 -，最多 ${TOOL_PREFIX_MAX} 个字符；留空沿用由名称生成的前缀。`}
      >
        <Input
          name="toolPrefix"
          value={prefix}
          onChange={(event) => setPrefix(event.target.value)}
          placeholder={suggestion ? `建议：${suggestion}` : '例如：team_kb'}
          maxLength={TOOL_PREFIX_MAX}
          pattern="[a-z0-9]+([_\-][a-z0-9]+)*"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={invalid ? true : undefined}
        />
      </Field>
      {invalid ? (
        <p role="alert" className="text-sm text-destructive">
          {invalid}
        </p>
      ) : null}
      {needsPrefix ? (
        <p role="status" className="attention text-sm">
          名称里没有英文，工具名前缀会变成一串编号
          {current ? `（现在是 ${current}__…）` : '（例如 c3595bf__…）'}。建议填一个英文标识。
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {suggestion && suggestion !== typed ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setPrefix(suggestion)}>
            使用建议值 {suggestion}
          </Button>
        ) : null}
        {effective ? (
          <span>
            客户端中的名称示例：<code>{effective}__工具名</code>
          </span>
        ) : null}
      </div>
      {connectionId && current && effective && effective !== current ? (
        <p role="status" className="attention text-sm">
          保存后这个连接的工具名会从 <code>{current}__…</code> 变成 <code>{effective}__…</code>
          ；已接入的客户端需要刷新工具列表（t_ 开头的旧名称仍可调用）。
        </p>
      ) : null}
    </div>
  );
}
