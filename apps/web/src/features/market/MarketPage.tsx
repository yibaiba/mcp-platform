import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RegistryServer, RegistryInputField, MarketSelection } from '@platform/contracts';
import { api, json, type Device } from '../../lib/api.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import {
  Action,
  Code,
  Empty,
  Feedback,
  Field,
  Form,
  value,
} from '../../components/shared/Controls.js';
type Page = { servers: { server: RegistryServer }[]; metadata: { nextCursor?: string } };
type Choice = {
  distribution: 'package' | 'remote';
  index: number;
  label: string;
  unsupported?: string;
  fields: (RegistryInputField & { key: string })[];
};
type Detail = { server: RegistryServer; choices: Choice[] };
export default function MarketPage() {
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const listing = useQuery({
    queryKey: ['market', search, cursor],
    queryFn: () => {
      const query = new URLSearchParams();
      if (search) query.set('search', search);
      if (cursor) query.set('cursor', cursor);
      return api<Page>(`/market/servers?${query}`);
    },
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">MCP REGISTRY</span>
          <h1>服务市场</h1>
          <p>从官方 Registry 选择固定版本，在平台或设备安装并连接。</p>
        </div>
      </div>
      <Card className="panel padded">
        <Form
          label="搜索"
          submit={async (data) => {
            setSearch(value(data, 'search'));
            setCursor(undefined);
          }}
        >
          <Field label="服务名称" hint="官方搜索要求至少三个字符；留空浏览服务。">
            <Input name="search" placeholder="filesystem" />
          </Field>
        </Form>
      </Card>
      <Feedback error={listing.error} />
      {selected ? (
        <MarketDetail key={selected} name={selected} close={() => setSelected(undefined)} />
      ) : null}
      <Card className="panel padded">
        <h2>搜索结果</h2>
        {listing.isPending ? <p role="status">正在请求官方目录…</p> : null}
        {listing.data?.servers.length === 0 ? (
          <Empty>没有匹配的服务。</Empty>
        ) : (
          listing.data?.servers.map(({ server }) => (
            <div className="connection-row" key={`${server.name}:${server.version}`}>
              <h3>{server.title ?? server.name}</h3>
              <small>
                {server.name} · {server.version}
              </small>
              <p>{server.description}</p>
              <Button onClick={() => setSelected(server.name)}>详情与安装</Button>
            </div>
          ))
        )}
        {listing.data?.metadata.nextCursor ? (
          <Button onClick={() => setCursor(listing.data!.metadata.nextCursor)}>下一页</Button>
        ) : null}
        {cursor ? (
          <Button variant="outline" onClick={() => setCursor(undefined)}>
            返回首页
          </Button>
        ) : null}
      </Card>
    </>
  );
}
function MarketDetail({ name, close }: { name: string; close: () => void }) {
  const [version, setVersion] = useState('latest');
  const detail = useQuery({
    queryKey: ['market-detail', name, version],
    queryFn: () => api<Detail>(`/market/server?${new URLSearchParams({ name, version })}`),
  });
  const versions = useQuery({
    queryKey: ['market-versions', name],
    queryFn: () => api<Page>(`/market/versions?${new URLSearchParams({ name })}`),
  });
  return (
    <Card className="panel padded">
      <div className="row">
        <h2 className="grow">{detail.data?.server.title ?? name}</h2>
        <Button variant="outline" onClick={close}>
          关闭详情
        </Button>
      </div>
      <Feedback error={detail.error ?? versions.error} />
      <Field label="服务版本">
        <select value={version} onChange={(event) => setVersion(event.target.value)}>
          <option value="latest">最新版本（{detail.data?.server.version ?? '加载中'}）</option>
          {versions.data?.servers.map(({ server }) => (
            <option key={server.version} value={server.version}>
              {server.version}
            </option>
          ))}
        </select>
      </Field>
      <p>{detail.data?.server.description}</p>
      {detail.data?.server.websiteUrl ? (
        <a href={detail.data.server.websiteUrl} target="_blank" rel="noreferrer">
          服务网站
        </a>
      ) : null}
      {detail.data ? (
        <Installation key={`${name}:${detail.data.server.version}`} detail={detail.data} />
      ) : null}
    </Card>
  );
}
function Installation({ detail }: { detail: Detail }) {
  const [choiceIndex, setChoiceIndex] = useState(0);
  const [adapter, setAdapter] = useState<MarketSelection['adapter']>('direct');
  const [preview, setPreview] = useState<{
    config: unknown;
    previewHash: string;
    installationSource?: { package?: { source: string }; reason?: string };
  }>();
  const [selection, setSelection] = useState<MarketSelection>();
  const [installed, setInstalled] = useState<{ connectionId: string; status: string }>();
  const devices = useQuery({ queryKey: ['devices'], queryFn: () => api<Device[]>('/devices') });
  const choice = detail.choices[choiceIndex];
  if (!choice) return <p>此版本没有可用的包或远程地址；请查看服务网站的配置说明。</p>;
  return (
    <>
      <Feedback error={devices.error} />
      <Field label="运行方式">
        <select
          value={choiceIndex}
          onChange={(event) => {
            setChoiceIndex(Number(event.target.value));
            setPreview(undefined);
          }}
        >
          {detail.choices.map((choice, index) => (
            <option key={index} value={index}>
              {choice.label}
            </option>
          ))}
        </select>
      </Field>
      {choice.unsupported ? (
        <p role="status">{choice.unsupported}</p>
      ) : (
        <div onChange={() => setPreview(undefined)}>
          <Form
            key={choiceIndex}
            label="预览安装配置"
            submit={async (data) => {
              const values = Object.fromEntries(
                choice.fields.flatMap((field) => {
                  const text = value(data, field.key);
                  if (text === '' && !field.isRequired) return [];
                  return [
                    [
                      field.key,
                      field.isRepeated ? text.split('\n').filter((line) => line !== '') : text,
                    ],
                  ];
                }),
              );
              const input: MarketSelection = {
                serverName: detail.server.name,
                version: detail.server.version,
                distribution: choice.distribution,
                index: choice.index,
                adapter,
                name: value(data, 'connectionName'),
                deviceId: adapter === 'device' ? value(data, 'deviceId') : undefined,
                executable: value(data, 'executable') || undefined,
                values,
              };
              setPreview(await api('/market/preview', { method: 'POST', body: json(input) }));
              setSelection(input);
              setInstalled(undefined);
            }}
          >
            <Field label="连接名称">
              <Input
                name="connectionName"
                required
                defaultValue={detail.server.title ?? detail.server.name}
              />
            </Field>
            <Field label="执行位置">
              <select
                value={adapter}
                onChange={(event) => {
                  setAdapter(event.target.value as MarketSelection['adapter']);
                  setPreview(undefined);
                }}
              >
                <option value="direct">平台 · Direct</option>
                <option value="pi">平台 · Pi 桥接</option>
                <option value="device">我的设备</option>
              </select>
            </Field>
            {adapter === 'device' ? (
              <Field label="目标设备">
                <select name="deviceId" required>
                  {devices.data?.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            {choice.distribution === 'package' ? (
              <Field
                label="包内可执行程序"
                hint="可留空使用包默认入口；入口名不同于包名时请明确填写。"
              >
                <Input name="executable" />
              </Field>
            ) : null}
            {choice.fields.map((field) => (
              <Field
                key={field.key}
                label={field.name ?? field.valueHint ?? field.key}
                hint={`${field.description ?? ''}${field.isRepeated ? ' 每行一个值。' : ''}`}
              >
                {field.choices ? (
                  <select
                    name={field.key}
                    defaultValue={field.default ?? ''}
                    required={field.isRequired}
                  >
                    <option value="">请选择</option>
                    {field.choices.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                ) : field.isRepeated ? (
                  <Textarea
                    name={field.key}
                    required={field.isRequired}
                    defaultValue={field.default}
                  />
                ) : (
                  <Input
                    name={field.key}
                    type={field.isSecret ? 'password' : 'text'}
                    autoComplete="off"
                    required={field.isRequired}
                    defaultValue={field.isSecret ? undefined : field.default}
                  />
                )}
              </Field>
            ))}
          </Form>
        </div>
      )}
      {preview && selection ? (
        <>
          <h3>执行预览</h3>
          <p>
            安装版本：{selection.version}
            。下载或启动失败会保留连接诊断；只有真实发现成功才显示已连接。
          </p>
          {preview.installationSource ? (
            <p style={{ overflowWrap: 'anywhere' }}>
              最终安装源：
              {preview.installationSource.package?.source ??
                preview.installationSource.reason ??
                '无法识别唯一来源'}
            </p>
          ) : null}
          <Code value={preview.config} />
          <Action
            action={async () =>
              setInstalled(
                await api('/market/install', {
                  method: 'POST',
                  body: json({ ...selection, previewHash: preview.previewHash }),
                }),
              )
            }
          >
            安装并连接
          </Action>
        </>
      ) : null}
      {installed ? (
        <p role="status">
          已连接 · <a href="/connections">查看连接和工具</a>
        </p>
      ) : null}
    </>
  );
}
