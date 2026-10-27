import { useState } from 'react';
import {
  connectorAuthenticationLabels,
  type ConnectorAuthentication,
  type ConnectorPreset,
} from '@platform/contracts';
import { Field, Form, value } from '../../components/shared/Controls.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { Input } from '../../components/ui/input.js';
import { SelectItem } from '../../components/ui/select.js';
import { api, json } from '../../lib/api.js';
import { presetConnection } from './presetConnection.js';

export function ConnectorForm({
  preset,
  onSaved,
}: {
  preset: ConnectorPreset;
  onSaved: (result: { id: string }, authentication: ConnectorAuthentication) => Promise<void>;
}) {
  const [authentication, setAuthentication] = useState<ConnectorAuthentication>(
    preset.authentication[0]!,
  );
  const [adapter, setAdapter] = useState<'direct' | 'pi'>('direct');
  const [transport, setTransport] = useState<'http' | 'stdio'>('http');
  const oauthSteps =
    adapter === 'pi'
      ? 'Pi 管理注册、授权与刷新，平台自动接收回调。预注册应用需先登记平台回调地址。'
      : '保存后展开“上游授权绑定”，查看“授权状态”获取回调地址并填入应用设置，再发起授权。';
  return (
    <Form
      label={
        authentication === 'oauth'
          ? preset.oauthRegistration
            ? '保存并配置授权'
            : '保存并授权'
          : '保存并连接'
      }
      submit={async (data) => {
        const config = presetConnection({
          preset,
          authentication,
          adapter,
          transport,
          name: value(data, 'name'),
          token: value(data, 'token'),
          clientId: value(data, 'clientId'),
          clientSecret: value(data, 'clientSecret'),
        });
        const created = await api<{ id: string }>('/connections', {
          method: 'POST',
          body: json(config),
        });
        await onSaved(created, authentication);
      }}
    >
      <Field label="连接名称">
        <Input name="name" defaultValue={preset.name} required />
      </Field>
      {preset.stdio ? (
        <Field
          label="运行方式"
          hint="远程服务免安装；本地进程由平台主机执行，需要 Node.js / npx 和 npm 网络访问。"
        >
          <SelectControl
            value={transport}
            onValueChange={(method) => setTransport(method as 'http' | 'stdio')}
          >
            <SelectItem value="http">官方远程服务（免安装）</SelectItem>
            <SelectItem value="stdio">本地进程（stdio）</SelectItem>
          </SelectControl>
        </Field>
      ) : null}
      {transport === 'stdio' && preset.stdio ? (
        <Field
          label="启动命令"
          hint={`在平台主机执行；令牌通过 ${preset.stdio.tokenEnv} 环境变量传入，不放入命令参数。`}
        >
          <Input value={[preset.stdio.command, ...preset.stdio.args].join(' ')} readOnly />
        </Field>
      ) : (
        <Field label="官方 MCP 地址" hint="连接官方远程服务，无需在设备上安装程序。">
          <Input value={preset.url} readOnly />
        </Field>
      )}
      <Field label="连接方式" hint="两种方式均无需模型。Pi 桥接复用现有 MCP 管理与 OAuth 能力。">
        <SelectControl
          value={adapter}
          onValueChange={(method) => setAdapter(method as 'direct' | 'pi')}
        >
          <SelectItem value="direct">平台直连</SelectItem>
          <SelectItem value="pi">Pi 桥接（无需模型）</SelectItem>
        </SelectControl>
      </Field>
      <Field label="认证方式" hint={preset.hint}>
        <SelectControl
          value={authentication}
          onValueChange={(method) => setAuthentication(method as ConnectorAuthentication)}
        >
          {preset.authentication.map((method) => (
            <SelectItem key={method} value={method}>
              {connectorAuthenticationLabels[method]}
            </SelectItem>
          ))}
        </SelectControl>
      </Field>
      {authentication === 'bearer' ? (
        <Field label="Token / API Key" hint="仅发送至平台加密保存，不写入浏览器持久存储。">
          <Input
            name="token"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            required
          />
        </Field>
      ) : null}
      {authentication === 'oauth' && preset.oauthRegistration ? (
        <div className="form-grid">
          <Field label="OAuth Client ID">
            <Input name="clientId" autoComplete="off" spellCheck={false} required />
          </Field>
          <Field label="OAuth Client Secret" hint="加密保存；OAuth 回调由所选连接方式管理。">
            <Input name="clientSecret" type="password" autoComplete="new-password" required />
          </Field>
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {authentication === 'oauth' && preset.oauthRegistration
          ? oauthSteps
          : authentication === 'oauth'
            ? '保存后自动进入供应商授权页，确认权限后自动返回并发现工具。'
            : '保存后自动连接并发现工具。'}{' '}
        Agent 的身份与工具权限在工作空间中单独配置。
      </p>
    </Form>
  );
}
