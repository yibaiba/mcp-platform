import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, json, type ContentEntry } from '../../lib/api.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Code, Empty, Feedback, Field, Form, value } from '../../components/shared/Controls.js';
import { Disclosure } from '../../components/shared/Disclosure.js';

export function ContentCatalog({
  connectionNames,
  profileId,
}: {
  connectionNames: Map<string, string>;
  profileId?: string;
}) {
  const catalog = useQuery({
    queryKey: ['catalog', profileId],
    queryFn: async () =>
      profileId
        ? (await api<{ content: ContentEntry[] }>(`/profiles/${profileId}/agent/catalog`)).content
        : api<ContentEntry[]>('/catalog'),
  });
  const [selected, setSelected] = useState<ContentEntry>();
  const [result, setResult] = useState<unknown>();
  return (
    <section className="space-y-4" aria-label="提示词与资源">
      <Feedback error={catalog.error} />
      <div className="tool-layout">
        <Card className="panel">
          {catalog.data?.length ? (
            catalog.data.map((entry) => (
              <Button
                key={entry.id}
                className={`tool-option ${selected?.id === entry.id ? 'selected' : ''}`}
                onClick={() => {
                  setSelected(entry);
                  setResult(undefined);
                }}
              >
                <strong>{entry.name}</strong>
                <small>
                  {entry.kind === 'prompt'
                    ? 'Prompt'
                    : entry.kind === 'resource'
                      ? 'Resource'
                      : '资源模板'}{' '}
                  · {connectionNames.get(entry.connectionId)}
                </small>
                <p>{entry.definition.description ?? entry.locator}</p>
              </Button>
            ))
          ) : (
            <Empty title="这个连接没有提供提示词或资源" />
          )}
        </Card>
        <Card className="panel padded">
          {selected ? (
            <>
              <h3>{selected.name}</h3>
              <Disclosure title="完整定义">
                <Code value={selected.definition} />
              </Disclosure>
              <Form
                key={selected.id}
                label={selected.kind === 'prompt' ? '获取 Prompt' : '读取 Resource'}
                submit={async (data) => {
                  const path =
                    selected.kind === 'prompt'
                      ? `${profileId ? `/profiles/${profileId}/agent` : '/catalog'}/prompts/${selected.id}/get`
                      : profileId
                        ? `/profiles/${profileId}/agent/resources/read`
                        : '/catalog/resources/read';
                  const body =
                    selected.kind === 'prompt'
                      ? {
                          arguments: Object.fromEntries(
                            (selected.definition.arguments ?? [])
                              .map((argument) => [
                                argument.name,
                                value(data, `arg:${argument.name}`),
                              ])
                              .filter(([, input]) => input !== ''),
                          ),
                        }
                      : { uri: value(data, 'uri') };
                  setResult(await api(path, { method: 'POST', body: json(body) }));
                }}
              >
                {selected.kind === 'prompt' ? (
                  selected.definition.arguments?.map((argument) => (
                    <Field key={argument.name} label={argument.name} hint={argument.description}>
                      <Input name={`arg:${argument.name}`} required={argument.required} />
                    </Field>
                  ))
                ) : (
                  <Field
                    label="资源 URI"
                    hint={
                      selected.kind === 'template' ? '将模板变量替换为实际值后读取。' : undefined
                    }
                  >
                    <Input
                      name="uri"
                      required
                      defaultValue={`mcp-platform://${selected.connectionId}/${selected.locator}`}
                    />
                  </Field>
                )}
              </Form>
              {result !== undefined ? (
                <>
                  <h3>返回结果</h3>
                  <Code value={result} />
                </>
              ) : null}
            </>
          ) : (
            <Empty>选择 Prompt、Resource 或资源模板。</Empty>
          )}
        </Card>
      </div>
    </section>
  );
}
