import { useState } from 'react';
import { catalogOptions, type CatalogOptions } from '@platform/contracts';
import {
  api,
  json,
  type Profile,
  type Tool,
  type ContentEntry,
  type Connection,
} from '../../lib/api.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Button } from '../../components/ui/button.js';
import { Action, Field } from '../../components/shared/Controls.js';
import { CheckChoice } from '../../components/shared/CheckChoice.js';

export function CatalogEditor(props: {
  profile: Profile;
  tools: Tool[];
  entries: ContentEntry[];
  connections: Connection[];
  close: () => void;
}) {
  const { profile } = props;
  const [config, setConfig] = useState<CatalogOptions>(() =>
    catalogOptions.parse(profile.catalog ?? {}),
  );
  const tools = props.tools.filter((t) =>
    [...profile.toolIds, ...profile.requestable.toolIds].includes(t.id),
  );
  const entries = props.entries.filter((t) =>
    [...profile.contentIds, ...profile.requestable.contentIds].includes(t.id),
  );
  const connectionIds = new Set([...tools, ...entries].map((entry) => entry.connectionId));
  const updateTool = (id: string, value: Partial<CatalogOptions['tools'][string]>) =>
    setConfig((current) => ({
      ...current,
      tools: {
        ...current.tools,
        [id]: { ...(current.tools[id] ?? { hiddenParameters: [] }), ...value },
      },
    }));
  return (
    <div className="grid gap-4">
      <Field label="工具命名方式">
        <select
          value={config.toolNaming}
          onChange={(event) =>
            setConfig({ ...config, toolNaming: event.target.value as CatalogOptions['toolNaming'] })
          }
        >
          <option value="stable">稳定名称（默认）</option>
          <option value="original">上游原名</option>
          <option value="prefixed">连接前缀 + 原名</option>
        </select>
      </Field>
      {config.toolNaming === 'prefixed'
        ? [...connectionIds].map((id) => (
            <Field
              key={id}
              label={`${props.connections.find((c) => c.id === id)?.name ?? id} 的前缀`}
            >
              <Input
                required
                value={config.connectionAliases[id] ?? ''}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    connectionAliases: { ...config.connectionAliases, [id]: event.target.value },
                  })
                }
              />
            </Field>
          ))
        : null}
      {tools.map((tool) => {
        const override = config.tools[tool.id];
        const schema = tool.definition.inputSchema as {
          properties?: Record<string, unknown>;
          required?: string[];
        };
        return (
          <fieldset key={tool.id}>
            <legend>{tool.name}</legend>
            <Field label="显式工具别名" hint="留空时使用上方命名方式；重名会明确报错。">
              <Input
                value={override?.alias ?? ''}
                onChange={(event) =>
                  updateTool(tool.id, { alias: event.target.value || undefined })
                }
              />
            </Field>
            <CheckChoice
              checked={override?.description !== undefined}
              onCheckedChange={(checked) =>
                updateTool(tool.id, {
                  description: checked ? String(tool.definition.description ?? '') : undefined,
                })
              }
            >
              自定义工具描述
            </CheckChoice>
            {override?.description !== undefined ? (
              <Textarea
                aria-label={`${tool.name} 描述`}
                value={override.description}
                onChange={(event) => updateTool(tool.id, { description: event.target.value })}
              />
            ) : (
              <small>{tool.definition.description}</small>
            )}
            <p>隐藏后客户端也不能传入该参数。仅支持顶层可选参数。</p>
            {Object.keys(schema.properties ?? {}).map((field) => (
              <CheckChoice
                key={field}
                disabled={schema.required?.includes(field)}
                checked={override?.hiddenParameters.includes(field) ?? false}
                onCheckedChange={(checked) =>
                  updateTool(tool.id, {
                    hiddenParameters: checked
                      ? [...(override?.hiddenParameters ?? []), field]
                      : (override?.hiddenParameters ?? []).filter((name) => name !== field),
                  })
                }
              >
                {field}
                {schema.required?.includes(field) ? '（必填，不能隐藏）' : ''}
              </CheckChoice>
            ))}
          </fieldset>
        );
      })}
      {entries.map((entry) => (
        <fieldset key={entry.id}>
          <legend>
            {entry.kind} · {entry.name}
          </legend>
          <CheckChoice
            checked={config.content[entry.id]?.description !== undefined}
            onCheckedChange={(checked) =>
              setConfig({
                ...config,
                content: {
                  ...config.content,
                  [entry.id]: {
                    description: checked ? (entry.definition.description ?? '') : undefined,
                  },
                },
              })
            }
          >
            自定义描述
          </CheckChoice>
          {config.content[entry.id]?.description !== undefined ? (
            <Textarea
              aria-label={`${entry.name} 描述`}
              value={config.content[entry.id]!.description}
              onChange={(event) =>
                setConfig({
                  ...config,
                  content: { ...config.content, [entry.id]: { description: event.target.value } },
                })
              }
            />
          ) : (
            <small>{entry.definition.description}</small>
          )}
        </fieldset>
      ))}
      <div className="row-actions">
        <Action
          action={async () => {
            await api(`/profiles/${profile.id}`, {
              method: 'PUT',
              body: json({
                name: profile.name,
                instructions: profile.instructions,
                toolIds: profile.toolIds,
                contentIds: profile.contentIds,
                artifactIds: profile.artifactIds,
                skillVersionIds: profile.skillVersionIds,
                revision: profile.revision,
                catalog: catalogOptions.parse(config),
              }),
            });
            props.close();
          }}
        >
          保存目录配置
        </Action>
        <Button variant="outline" onClick={props.close}>
          取消
        </Button>
      </div>
    </div>
  );
}
