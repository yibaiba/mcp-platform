import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { BundleHistory } from './BundleHistory.js';
import { useState } from 'react';
import type { McpbManifest } from '@platform/contracts';
import { api, json, type Device, type Connection } from '../../lib/api.js';
import { Action, Code, Field, Form, value } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { BundleFields, bundleValues } from './BundleFields.js';
type Package = { id: string; sha256: string; manifest: McpbManifest };
export function BundlePanel({
  devices,
  connections,
  defaultOpen = false,
}: {
  devices: Device[];
  connections: Connection[];
  defaultOpen?: boolean;
}) {
  const [pkg, setPackage] = useState<Package>();
  const [review, setReview] = useState<{ input: object; preview: unknown }>();
  const [result, setResult] = useState<unknown>();
  return (
    <Disclosure defaultOpen={defaultOpen} title="导入 MCPB 扩展包">
      <p>
        上传和预览不执行代码。安装会在所选位置启动 MCP
        并验证连接；依赖必须已随包提供或在目标环境可用。
      </p>
      <Form
        label="上传并解析"
        submit={async (data) => {
          const file = data.get('archive');
          if (!(file instanceof File) || !file.size) throw new Error('请选择 MCPB 文件');
          setReview(undefined);
          setResult(undefined);
          setPackage(
            await api<Package>('/bundles/mcpb', {
              method: 'POST',
              body: file,
              headers: { 'Content-Type': 'application/zip' },
            }),
          );
        }}
      >
        <Field label="MCPB 文件">
          <Input name="archive" type="file" accept=".mcpb" required />
        </Field>
      </Form>
      {pkg ? (
        <div key={pkg.id}>
          <h3>
            {pkg.manifest.display_name ?? pkg.manifest.name} · {pkg.manifest.version}
          </h3>
          <p>{pkg.manifest.description}</p>
          <Form
            label="预览执行配置"
            onChange={() => setReview(undefined)}
            submit={async (data) => {
              const adapter = value(data, 'adapter');
              const destination = {
                adapter,
                ...(adapter === 'device' ? { deviceId: value(data, 'deviceId') } : {}),
                values: bundleValues(data, pkg.manifest),
              };
              const preview = await api<{ previewDigest: string }>(
                `/bundles/mcpb/${pkg.id}/preview`,
                { method: 'POST', body: json(destination) },
              );
              const connection = connections.find((c) => c.id === value(data, 'connectionId'));
              setReview({
                preview,
                input: {
                  ...destination,
                  operationId: crypto.randomUUID(),
                  previewDigest: preview.previewDigest,
                  ...(connection
                    ? { connectionId: connection.id, revision: connection.revision }
                    : {}),
                },
              });
            }}
          >
            <Field label="执行位置">
              <SelectControl name="adapter" defaultValue="direct">
                <SelectItem value="direct">平台直连</SelectItem>
                <SelectItem value="pi">平台 Pi 桥接</SelectItem>
                <SelectItem value="device">设备连接器</SelectItem>
              </SelectControl>
            </Field>
            <Field label="目标设备（设备执行时必选）">
              <SelectControl name="deviceId" defaultValue="">
                <SelectItem value="">请选择</SelectItem>
                {devices
                  .filter((d) => !d.revoked)
                  .map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name} · {d.online ? '在线' : '离线'}
                    </SelectItem>
                  ))}
              </SelectControl>
            </Field>
            <Field label="安装方式" hint="替换会停止并重新连接目标服务；失败不自动回滚。">
              <SelectControl name="connectionId" defaultValue="">
                <SelectItem value="">创建新连接</SelectItem>
                {connections
                  .filter((c) => c.source !== 'library')
                  .map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      替换：{c.name}
                    </SelectItem>
                  ))}
              </SelectControl>
            </Field>
            <BundleFields manifest={pkg.manifest} />
          </Form>
        </div>
      ) : null}
      {review && pkg ? (
        <>
          <Code value={review.preview} />
          <Action
            action={async () => {
              const installed = await api<{ state: string; error?: string }>(
                `/bundles/mcpb/${pkg.id}/install`,
                { method: 'POST', body: json(review.input) },
              );
              setResult(installed);
              if (installed.state === 'failed') throw new Error(installed.error);
            }}
          >
            安装并连接
          </Action>
        </>
      ) : null}
      {result ? <Code value={result} /> : null}
      <BundleHistory />
    </Disclosure>
  );
}
