import { useState } from 'react';
import { api, json } from '../../lib/api.js';
import { Form, Field, Code, value } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
type Preview = {
  document: Record<string, unknown>;
  title?: string;
  servers: { url: string }[];
  schemes: unknown;
  operations: {
    key: string;
    description?: string;
    parameters: unknown;
    security: unknown;
    unsupported: string[];
    servers: { url: string }[];
  }[];
};
export function OpenApiPanel({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [preview, setPreview] = useState<Preview>();
  const [revision, setRevision] = useState(0);
  return (
    <Disclosure defaultOpen={defaultOpen} title="从 OpenAPI 文档添加连接" className="panel padded">
      <p>导入 OpenAPI 3.0/3.1 JSON 或 YAML，预览后选择发布操作。API 请求在平台执行。</p>
      <Form
        label="读取并预览"
        submit={async (data) => {
          setPreview(
            await api('/openapi/preview', {
              method: 'POST',
              body: json({
                url: value(data, 'documentUrl') || undefined,
                artifactId: value(data, 'artifactId') || undefined,
                documentHeaders: JSON.parse(value(data, 'documentHeaders') || '{}'),
                referenceHeaders: JSON.parse(value(data, 'referenceHeaders') || '{}'),
                referenceOrigins: value(data, 'origins')
                  .split(',')
                  .map((v) => v.trim())
                  .filter(Boolean),
              }),
            }),
          );
          setRevision((v) => v + 1);
        }}
      >
        <Field label="文档 URL">
          <Input name="documentUrl" type="url" onChange={() => setPreview(undefined)} />
        </Field>
        <Field label="文档请求头（JSON，可选）" hint="仅用于读取文档 URL，不传给引用或 API 执行。">
          <Textarea
            name="documentHeaders"
            defaultValue="{}"
            onChange={() => setPreview(undefined)}
          />
        </Field>
        <Field label="外部引用请求头（来源 → 请求头 JSON，可选）">
          <Textarea
            name="referenceHeaders"
            defaultValue="{}"
            onChange={() => setPreview(undefined)}
          />
        </Field>
        <Field label="或已上传的文档文件 ID">
          <Input name="artifactId" onChange={() => setPreview(undefined)} />
        </Field>
        <Field
          label="允许的外部引用来源"
          hint="逗号分隔的 HTTP(S) 来源。文档凭证与 API 凭证分开配置。"
        >
          <Input name="origins" onChange={() => setPreview(undefined)} />
        </Field>
      </Form>
      {preview ? (
        <Form
          key={revision}
          label="发布选择的操作"
          submit={async (data) => {
            await api('/connections', {
              method: 'POST',
              body: json({
                name: value(data, 'name'),
                source: 'openapi',
                adapter: 'direct',
                transport: 'http',
                mode: 'existing',
                openapi: {
                  document: preview.document,
                  baseUrl: value(data, 'baseUrl'),
                  operations: data.getAll('operation'),
                  credentials: JSON.parse(value(data, 'credentials')),
                  securityChoices: JSON.parse(value(data, 'securityChoices')),
                },
              }),
            });
            setPreview(undefined);
          }}
        >
          <Field label="连接名称">
            <Input name="name" defaultValue={preview.title} required />
          </Field>
          <Field
            label="API 服务地址"
            hint={`文档声明：${preview.servers.map((s) => s.url).join('、') || '无'}。此处显式地址覆盖文档、路径及操作级服务器地址。`}
          >
            <Input name="baseUrl" type="url" required />
          </Field>
          {preview.operations.map((op) => (
            <div key={op.key}>
              <CheckChoice name="operation" value={op.key} disabled={op.unsupported.length > 0}>
                <strong>{op.key}</strong>
                <span>{op.description}</span>
              </CheckChoice>
              {op.unsupported.length ? <p className="error">{op.unsupported.join('；')}</p> : null}
              <Disclosure title="参数与认证组合">
                <Code
                  value={{ servers: op.servers, parameters: op.parameters, security: op.security }}
                />
              </Disclosure>
            </div>
          ))}
          <Disclosure title="认证方案">
            <Code value={preview.schemes} />
          </Disclosure>
          <Field label="认证凭证（按方案名称填写 JSON）">
            <Textarea name="credentials" defaultValue="{}" rows={5} />
          </Field>
          <Field label="OR 认证选择（操作名称 → 从 0 开始的方案索引）">
            <Textarea name="securityChoices" defaultValue="{}" rows={3} />
          </Field>
        </Form>
      ) : null}
    </Disclosure>
  );
}
