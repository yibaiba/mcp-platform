import { useEffect, useState } from 'react';
import { unzipSync } from 'fflate';
import {
  compileBundle,
  mcpbManifest,
  type McpbManifest,
  type BundleEnvironment,
} from '@platform/contracts';
import type { ManagementApi } from '../local/api.js';
import { Action, Code, Feedback, Field, Form } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { BundleFields, bundleValues } from './BundleFields.js';
type Item = { sha256: string; name: string; version: string; revision: string };
export function LocalBundles({ api }: { api: ManagementApi }) {
  const [pkg, setPackage] = useState<{
    archive: string;
    sha256: string;
    manifest: McpbManifest;
    environment: BundleEnvironment;
  }>();
  const [review, setReview] = useState<{ config: object; display: unknown; operationId: string }>();
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<unknown>();
  const refresh = async () => setItems((await api.request({ action: 'mcpb.list' })) as Item[]);
  useEffect(() => {
    void refresh().catch(setError);
  }, [api]);
  return (
    <section>
      <h2>本机 MCPB 扩展包</h2>
      <p>
        配置加密保存在本机。保存后可在本机资源中选择同步，再到平台授权给
        Profile；也可复制客户端配置直接使用。安装不启动服务。
      </p>
      <Feedback error={error} />
      <Form
        label="解析本机 MCPB"
        submit={async (data) => {
          const file = data.get('archive');
          if (!(file instanceof File) || !file.size) throw new Error('请选择 MCPB 文件');
          const buffer = await file.arrayBuffer(),
            bytes = new Uint8Array(buffer);
          const sha256 = Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)),
            (b) => b.toString(16).padStart(2, '0'),
          ).join('');
          const raw = unzipSync(bytes)['manifest.json'];
          if (!raw) throw new Error('根目录缺少 manifest.json');
          const manifest = mcpbManifest.parse(JSON.parse(new TextDecoder().decode(raw)));
          const environment = (await api.request({
            action: 'mcpb.environment',
            id: sha256,
          })) as BundleEnvironment;
          let binary = '';
          for (const byte of bytes) binary += String.fromCharCode(byte);
          setPackage({ archive: btoa(binary), sha256, manifest, environment });
          setReview(undefined);
        }}
      >
        <Field label="MCPB 文件">
          <Input name="archive" type="file" accept=".mcpb" required />
        </Field>
      </Form>
      {pkg ? (
        <div key={pkg.sha256} onChange={() => setReview(undefined)}>
          <h3>
            {pkg.manifest.name} · {pkg.manifest.version}
          </h3>
          {pkg.environment.configurationRevision ? (
            <p>
              此包已有本机配置。保存将替换该修订，连接器管理的旧会话会关闭；外部客户端需停止现有会话、更新配置并重连。
            </p>
          ) : null}
          <Form
            label="预览本机配置"
            submit={async (data) => {
              const values = bundleValues(data, pkg.manifest);
              setReview({
                operationId: crypto.randomUUID(),
                config: {
                  ...compileBundle({
                    manifest: pkg.manifest,
                    environment: pkg.environment,
                    values,
                  }),
                  transport: 'stdio',
                  mode: 'managed',
                },
                display: compileBundle({
                  manifest: pkg.manifest,
                  environment: pkg.environment,
                  values,
                  redact: true,
                }),
              });
            }}
          >
            <BundleFields manifest={pkg.manifest} />
          </Form>
        </div>
      ) : null}
      {pkg && review ? (
        <>
          <Code value={review.display} />
          <Action
            action={async () => {
              setResult(
                await api.request({
                  action: 'mcpb.install',
                  content: {
                    sha256: pkg.sha256,
                    archive: pkg.archive,
                    config: review.config,
                    operationId: review.operationId,
                    revision: pkg.environment.configurationRevision,
                  },
                }),
              );
              await refresh();
              setReview(undefined);
              setPackage({
                ...pkg,
                environment: (await api.request({
                  action: 'mcpb.environment',
                  id: pkg.sha256,
                })) as BundleEnvironment,
              });
            }}
          >
            保存到本机
          </Action>
        </>
      ) : null}
      {items.map((item) => (
        <div key={item.sha256}>
          <strong>
            {item.name} · {item.version}
          </strong>
          <Action
            action={async () =>
              setResult(await api.request({ action: 'mcpb.start', id: item.sha256 }))
            }
          >
            连接验证
          </Action>
          <Action
            action={async () =>
              setResult(await api.request({ action: 'mcpb.stop', id: item.sha256 }))
            }
          >
            停止
          </Action>
          <Action
            action={async () =>
              setResult(await api.request({ action: 'mcpb.client', id: item.sha256 }))
            }
          >
            查看客户端配置
          </Action>
          <Action
            action={async () => {
              setResult(
                await api.request({
                  action: 'mcpb.remove',
                  id: item.sha256,
                  content: { revision: item.revision },
                }),
              );
              await refresh();
            }}
          >
            移除本机配置
          </Action>
          <p>
            移除会关闭连接器管理的连接并撤下同步资源；外部客户端需停止现有会话。包文件保留，避免影响平台在此设备上的安装。
          </p>
        </div>
      ))}
      {result ? <Code value={result} /> : null}
    </section>
  );
}
