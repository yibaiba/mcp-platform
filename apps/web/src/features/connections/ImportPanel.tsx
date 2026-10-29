import { Disclosure } from '../../components/shared/Disclosure.js';
import { useState } from 'react';
import type { ImportPreview } from '@platform/contracts';
import { SelectItem } from '../../components/ui/select.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Action, Code, Field, Form, value } from '../../components/shared/Controls.js';
import { api, json, type Device } from '../../lib/api.js';

export function ImportPanel({
  devices,
  defaultOpen = false,
}: {
  devices: Device[];
  defaultOpen?: boolean;
}) {
  const [review, setReview] = useState<{ input: unknown; preview: ImportPreview[] }>();
  const [result, setResult] = useState<unknown>();
  return (
    <Disclosure defaultOpen={defaultOpen} title="导入 MCP 配置" className="panel padded">
      <Form
        label="验证并预览"
        submit={async (data) => {
          setReview(undefined);
          setResult(undefined);
          const parsed: unknown = JSON.parse(value(data, 'config'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw new Error('配置必须是包含 mcpServers 的 JSON 对象');
          const deviceId = value(data, 'deviceId');
          const input = { ...parsed, ...(deviceId ? { deviceId } : {}) };
          const preview = await api<ImportPreview[]>('/import/preview', {
            method: 'POST',
            body: json(input),
          });
          setReview({ input, preview });
        }}
      >
        <Field
          label="配置 JSON"
          hint="填写 mcpServers；预览会列出未映射字段和需要处理的问题，不会迁移 OAuth 凭证"
        >
          <Textarea name="config" rows={6} required onChange={() => setReview(undefined)} />
        </Field>
        <Field
          label="本地服务的执行设备"
          hint="stdio 命令在所选设备执行；也可在 JSON 中填写 deviceId"
        >
          <SelectControl name="deviceId" defaultValue="" onValueChange={() => setReview(undefined)}>
            <SelectItem value="">使用 JSON 中的设备关联</SelectItem>
            {devices
              .filter((device) => !device.revoked)
              .map((device) => (
                <SelectItem key={device.id} value={device.id}>
                  {device.name}
                </SelectItem>
              ))}
          </SelectControl>
        </Field>
      </Form>
      {review ? (
        <>
          {review.preview.map((row) => (
            <div key={row.name} className="panel padded">
              <h3>{row.name}</h3>
              {row.errors.map((message) => (
                <p className="error" role="alert" key={message}>
                  {message}
                </p>
              ))}
              {row.warnings.map((warning) => (
                <p key={warning.field}>{warning.message}</p>
              ))}
              <small>{row.authorization}</small>
              <Disclosure title="查看映射后的连接配置">
                <Code value={row.config} />
              </Disclosure>
            </div>
          ))}
          {review.preview.every((row) => !row.errors.length) ? (
            <Action
              action={async () => {
                setResult(await api('/import/apply', { method: 'POST', body: json(review.input) }));
                setReview(undefined);
              }}
            >
              按上述映射导入
            </Action>
          ) : (
            <p>修正上述问题后，重新验证并预览。</p>
          )}
        </>
      ) : null}
      {result ? <Code value={result} /> : null}
    </Disclosure>
  );
}
