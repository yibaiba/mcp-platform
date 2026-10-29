import { useEffect, useState } from 'react';
import { libraryItem, type LibraryItem } from '@platform/contracts';
import { api, json } from '../../lib/api.js';
import { Field, Form, Code } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { PromptArguments } from './PromptArguments.js';
export function LibraryEditor({
  initial,
  onDirtyChange,
  save,
}: {
  initial: LibraryItem;
  onDirtyChange: (dirty: boolean) => void;
  save: (item: LibraryItem) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [argumentsJson, setArgumentsJson] = useState(
    initial.kind === 'prompt' ? JSON.stringify(initial.arguments) : '[]',
  );
  const [previewValues, setPreviewValues] = useState('{}');
  const [preview, setPreview] = useState<{ signature: string; value: unknown }>();
  const signature = JSON.stringify([draft, argumentsJson, previewValues]);
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(initial) ||
    (initial.kind === 'prompt' && argumentsJson !== JSON.stringify(initial.arguments));
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  function update(patch: Record<string, unknown>) {
    setDraft({ ...draft, ...patch });
    setPreview(undefined);
  }
  const parsedDraft = () =>
    libraryItem.parse(
      draft.kind === 'prompt' ? { ...draft, arguments: JSON.parse(argumentsJson) } : draft,
    );
  return (
    <>
      <p role="status" className="draft-state">
        {dirty ? '有未保存的修改' : '暂无未保存的修改'}
      </p>
      <Form
        submit={async () => {
          await save(parsedDraft());
        }}
      >
        <Field label="名称">
          <Input value={draft.name} required onChange={(e) => update({ name: e.target.value })} />
        </Field>
        <Field label="显示标题">
          <Input value={draft.title ?? ''} onChange={(e) => update({ title: e.target.value })} />
        </Field>
        <Field label="说明">
          <Input
            value={draft.description ?? ''}
            onChange={(e) => update({ description: e.target.value })}
          />
        </Field>
        {draft.kind === 'prompt' ? (
          <>
            <Field label="提示词模板" hint="使用 {{parameter}}；不执行表达式或脚本。">
              <Textarea
                className="library-template"
                rows={8}
                value={draft.template}
                required
                onChange={(e) => update({ template: e.target.value })}
              />
            </Field>
            <PromptArguments
              value={argumentsJson}
              onChange={(next) => {
                setArgumentsJson(next);
                setPreview(undefined);
              }}
            />
          </>
        ) : (
          <>
            <Field label="资源 URI">
              <Input value={draft.uri} required onChange={(e) => update({ uri: e.target.value })} />
            </Field>
            <Field label="MIME 类型">
              <Input
                value={draft.mimeType}
                required
                onChange={(e) => update({ mimeType: e.target.value })}
              />
            </Field>
            <Field label="静态文本">
              <Textarea
                className="library-template"
                rows={10}
                value={draft.content}
                onChange={(e) => update({ content: e.target.value })}
              />
            </Field>
          </>
        )}
        <Field label="状态">
          <select
            value={String(draft.enabled)}
            onChange={(e) => update({ enabled: e.target.value === 'true' })}
          >
            <option value="true">启用</option>
            <option value="false">停用</option>
          </select>
        </Field>
      </Form>
      {draft.kind === 'prompt' ? (
        <section className="draft-preview">
          <h3>预览当前草稿</h3>
          <p className="text-muted-foreground">使用上方当前内容预览，无需先保存。</p>
          <Form
            label="预览当前草稿"
            submit={async () => {
              setPreview(undefined);
              const result = await api<unknown>('/library/prompts/preview', {
                method: 'POST',
                body: json({
                  item: parsedDraft(),
                  arguments: JSON.parse(previewValues || '{}'),
                }),
              });
              setPreview({ signature, value: result });
            }}
          >
            <Field label="参数值（JSON）">
              <Textarea
                name="values"
                value={previewValues}
                onChange={(event) => {
                  setPreviewValues(event.target.value);
                  setPreview(undefined);
                }}
              />
            </Field>
          </Form>
          {preview ? (
            preview.signature === signature ? (
              <Code value={preview.value} />
            ) : (
              <p role="status">草稿已修改，请重新预览。</p>
            )
          ) : null}
        </section>
      ) : null}
    </>
  );
}
