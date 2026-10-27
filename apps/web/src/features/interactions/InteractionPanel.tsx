import { useQuery } from '@tanstack/react-query';
import { api, json } from '../../lib/api.js';
import { Action, Code, Field, Form, Feedback, value } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';

type Property = {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  oneOf?: { const: string; title?: string }[];
  default?: unknown;
};
type Request = {
  method: string;
  params: {
    mode?: 'form' | 'url';
    message: string;
    url?: string;
    requestedSchema?: { properties?: Record<string, Property>; required?: string[] };
  };
};
type Interaction = {
  id: string;
  connectionId: string;
  callId: string;
  active: boolean;
  managedExternally?: boolean;
  request: { inputRequests?: Record<string, Request> };
};
export function InteractionPanel({
  id,
  onResult,
}: {
  id?: string;
  onResult?: (result: unknown) => void;
}) {
  const query = useQuery({
    queryKey: ['interactions'],
    queryFn: () => api<Interaction[]>('/interactions'),
    refetchInterval: 1000,
  });
  return (
    <>
      <Feedback error={query.error} />
      {query.data
        ?.filter((entry) => !id || entry.id === id)
        .map((entry) => (
          <Card className="panel padded" key={entry.id}>
            <h3>服务请求补充信息</h3>
            <small>
              来源连接：{entry.connectionId} · 调用：{entry.callId}
            </small>
            {entry.managedExternally ? (
              <p role="status">此交互由原外部客户端处理；响应必须来自原调用身份。</p>
            ) : !entry.active ? (
              <p role="status">原运行会话已结束，此交互不能继续。</p>
            ) : (
              <Form
                noValidate
                label="确认并提交"
                submit={async (data) => {
                  const responses = Object.fromEntries(
                    Object.entries(entry.request.inputRequests ?? {}).map(([key, request]) => {
                      const action = value(data, `${key}:action`) || 'accept';
                      if (action !== 'accept' || request.params.mode === 'url')
                        return [key, { action }];
                      const content = Object.fromEntries(
                        Object.entries(request.params.requestedSchema?.properties ?? {}).flatMap(
                          ([name, property]) => {
                            const raw = value(data, `${key}:${name}`);
                            if (!raw && request.params.requestedSchema?.required?.includes(name))
                              throw new Error(`请填写 ${property.title ?? name}`);
                            if (!raw && !request.params.requestedSchema?.required?.includes(name))
                              return [];
                            const parsed =
                              property.type === 'boolean'
                                ? raw === 'true'
                                : property.type === 'number' || property.type === 'integer'
                                  ? Number(raw)
                                  : property.type === 'array'
                                    ? JSON.parse(raw)
                                    : raw;
                            return [[name, parsed]];
                          },
                        ),
                      );
                      return [key, { action, content }];
                    }),
                  );
                  const result = await api(`/interactions/${entry.id}/respond`, {
                    method: 'POST',
                    body: json(responses),
                  });
                  onResult?.(result);
                  await query.refetch();
                }}
              >
                {Object.entries(entry.request.inputRequests ?? {}).map(([key, request]) => (
                  <div key={key}>
                    <p>{request.params.message}</p>
                    {request.params.mode === 'url' ? (
                      <div>
                        <Code value={request.params.url} />
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            const url = new URL(request.params.url!);
                            if (!['https:', 'http:'].includes(url.protocol))
                              throw new Error('服务提供的 URL 协议无效');
                            if (
                              window.confirm(
                                `服务请求打开 ${url.origin}。确认后将在新窗口打开，平台不会提交登录凭证。`,
                              )
                            )
                              window.open(url.href, '_blank', 'noopener,noreferrer');
                          }}
                        >
                          确认后打开外部页面
                        </Button>
                        <p>完成外部页面操作后，再选择接受并提交。</p>
                      </div>
                    ) : (
                      Object.entries(request.params.requestedSchema?.properties ?? {}).map(
                        ([name, property]) => (
                          <Field
                            key={name}
                            label={property.title ?? name}
                            hint={property.description}
                          >
                            {property.enum || property.oneOf ? (
                              <SelectControl
                                name={`${key}:${name}`}
                                required={request.params.requestedSchema?.required?.includes(name)}
                              >
                                {(
                                  property.oneOf ??
                                  property.enum!.map((option) => ({ const: option, title: option }))
                                ).map((option) => (
                                  <SelectItem key={option.const} value={option.const}>
                                    {option.title ?? option.const}
                                  </SelectItem>
                                ))}
                              </SelectControl>
                            ) : property.type === 'boolean' ? (
                              <SelectControl name={`${key}:${name}`} defaultValue="false">
                                <SelectItem value="true">是</SelectItem>
                                <SelectItem value="false">否</SelectItem>
                              </SelectControl>
                            ) : property.type === 'array' ? (
                              <Textarea name={`${key}:${name}`} defaultValue="[]" />
                            ) : (
                              <Input
                                name={`${key}:${name}`}
                                type={
                                  property.type === 'number' || property.type === 'integer'
                                    ? 'number'
                                    : 'text'
                                }
                                step={property.type === 'integer' ? 1 : 'any'}
                                required={request.params.requestedSchema?.required?.includes(name)}
                                defaultValue={
                                  property.default === undefined ? '' : String(property.default)
                                }
                              />
                            )}
                          </Field>
                        ),
                      )
                    )}
                    <Field label="响应方式">
                      <SelectControl name={`${key}:action`} defaultValue="accept">
                        <SelectItem value="accept">接受</SelectItem>
                        <SelectItem value="decline">拒绝</SelectItem>
                        <SelectItem value="cancel">取消</SelectItem>
                      </SelectControl>
                    </Field>
                  </div>
                ))}
              </Form>
            )}
            <Action action={() => api(`/calls/${entry.callId}/cancel`, { method: 'POST' })}>
              中断原调用
            </Action>
          </Card>
        ))}
    </>
  );
}
