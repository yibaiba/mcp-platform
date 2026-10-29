import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LibraryItem } from '@platform/contracts';
import { api, json } from '../../lib/api.js';
import {
  Action,
  Field,
  Form,
  Feedback,
  Empty,
  Code,
  value,
} from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
type Item = LibraryItem & { id: string; revision: number; contentId: string };
export default function LibraryPage() {
  const [kind, setKind] = useState<'prompt' | 'resource'>('prompt');
  const [selected, setSelected] = useState<Item>();
  const [preview, setPreview] = useState<unknown>();
  const path = `/library/${kind === 'prompt' ? 'prompts' : 'resources'}`;
  const query = useQuery({ queryKey: ['library', kind], queryFn: () => api<Item[]>(path) });
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>内容库</h1>
          <p>维护自己的提示词和静态资源，再到 Agent 配置授权使用。</p>
        </div>
      </div>
      <Field label="内容类型">
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as typeof kind);
            setSelected(undefined);
            setPreview(undefined);
          }}
        >
          <option value="prompt">Prompt 提示词</option>
          <option value="resource">Resource 资源</option>
        </select>
      </Field>
      <Feedback error={query.error} />
      <div className="overview-grid">
        <Card className="panel padded">
          <h2>{selected ? '编辑内容' : '新建内容'}</h2>
          {selected ? (
            <Button
              variant="outline"
              onClick={() => {
                setSelected(undefined);
                setPreview(undefined);
              }}
            >
              新建另一条
            </Button>
          ) : null}
          <Form
            key={`${kind}:${selected?.id ?? 'new'}:${selected?.revision ?? 0}`}
            submit={async (data) => {
              const item = fromForm(data, kind);
              await api(selected ? `${path}/${selected.id}` : path, {
                method: selected ? 'PUT' : 'POST',
                body: json({ ...item, ...(selected ? { revision: selected.revision } : {}) }),
              });
              setSelected(undefined);
              setPreview(undefined);
            }}
          >
            <Field label="名称">
              <Input name="name" defaultValue={selected?.name} required />
            </Field>
            <Field label="显示标题">
              <Input name="title" defaultValue={selected?.title} />
            </Field>
            <Field label="说明">
              <Input name="description" defaultValue={selected?.description} />
            </Field>
            {kind === 'prompt' ? (
              <>
                <Field label="提示词模板" hint="使用 {{parameter}}；不执行表达式或脚本。">
                  <textarea
                    name="template"
                    rows={8}
                    defaultValue={selected?.kind === 'prompt' ? selected.template : ''}
                    required
                  />
                </Field>
                <Field label="参数声明（JSON）" hint={'例如 [{"name":"topic","required":true}]'}>
                  <textarea
                    name="arguments"
                    rows={4}
                    defaultValue={
                      selected?.kind === 'prompt'
                        ? JSON.stringify(selected.arguments, null, 2)
                        : '[]'
                    }
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="资源 URI">
                  <Input
                    name="uri"
                    defaultValue={selected?.kind === 'resource' ? selected.uri : ''}
                    required
                  />
                </Field>
                <Field label="MIME 类型">
                  <Input
                    name="mimeType"
                    defaultValue={selected?.kind === 'resource' ? selected.mimeType : 'text/plain'}
                    required
                  />
                </Field>
                <Field label="静态文本">
                  <textarea
                    name="content"
                    rows={10}
                    defaultValue={selected?.kind === 'resource' ? selected.content : ''}
                  />
                </Field>
              </>
            )}
            <Field label="状态">
              <select name="enabled" defaultValue={selected?.enabled === false ? 'false' : 'true'}>
                <option value="true">启用</option>
                <option value="false">停用</option>
              </select>
            </Field>
          </Form>
        </Card>
        <Card className="panel padded">
          <h2>我的内容</h2>
          {!query.data?.length ? (
            <Empty>还没有内容。</Empty>
          ) : (
            query.data.map((item) => (
              <div key={item.id} className="space-y-2 border-b py-3">
                <strong className="break-all">{item.name}</strong>
                <p>
                  {item.enabled ? '已启用' : '已停用'} · 修订 {item.revision}
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    setSelected(item);
                    setPreview(undefined);
                  }}
                >
                  编辑
                </Button>
                <Action
                  danger
                  action={async () => {
                    await api(`${path}/${item.id}`, {
                      method: 'DELETE',
                      body: json({ revision: item.revision }),
                    });
                    if (selected?.id === item.id) setSelected(undefined);
                  }}
                >
                  删除
                </Action>
              </div>
            ))
          )}
          {selected?.kind === 'prompt' ? (
            <Form
              label="预览已保存的模板"
              submit={async (data) => {
                const { id: _id, revision: _revision, contentId: _contentId, ...item } = selected;
                setPreview(
                  await api('/library/prompts/preview', {
                    method: 'POST',
                    body: json({ item, arguments: JSON.parse(value(data, 'values') || '{}') }),
                  }),
                );
              }}
            >
              <Field label="参数值（JSON）">
                <textarea name="values" defaultValue="{}" />
              </Field>
            </Form>
          ) : null}
          {preview ? <Code value={preview} /> : null}
        </Card>
      </div>
    </>
  );
}
function fromForm(data: FormData, kind: 'prompt' | 'resource') {
  const common = {
    kind,
    name: value(data, 'name'),
    description: value(data, 'description'),
    title: value(data, 'title'),
    enabled: value(data, 'enabled') === 'true',
  };
  return kind === 'prompt'
    ? {
        ...common,
        template: value(data, 'template'),
        arguments: JSON.parse(value(data, 'arguments') || '[]'),
      }
    : {
        ...common,
        uri: value(data, 'uri'),
        mimeType: value(data, 'mimeType'),
        content: value(data, 'content'),
      };
}
