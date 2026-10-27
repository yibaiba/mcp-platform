import { Disclosure } from '../../components/shared/Disclosure.js';
import { Card } from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, json, type Connection } from '../../lib/api.js';
import {
  Action,
  Code,
  date,
  Empty,
  Feedback,
  Field,
  Form,
  value,
} from '../../components/shared/Controls.js';
export default function AuthorizationsPage() {
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<Connection[]>('/connections'),
  });
  const grants = useQuery({
    queryKey: ['grants'],
    queryFn: () =>
      api<{ id: string; profileId: string; revoked: boolean; expiresAt: string }[]>(
        '/oauth/grants',
      ),
  });
  const [result, setResult] = useState<unknown>();
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">AUTHORIZATIONS</span>
          <h1>授权连接</h1>
          <p>平台登录、Agent 接入授权与上游 MCP 凭证分别管理。</p>
        </div>
      </div>
      <Feedback error={connections.error ?? grants.error} />
      <Card className="panel">
        <div className="panel-heading">
          <h2>上游 MCP 授权</h2>
        </div>
        {connections.data
          ?.filter((c) => c.adapter !== 'device' && c.transport !== 'stdio')
          .map((connection) => (
            <div className="connection-row" key={connection.id}>
              <h3>{connection.name}</h3>
              <small>
                {connection.adapter === 'pi'
                  ? '由 Pi 适配器持有凭证'
                  : '由平台官方 MCP SDK 持有凭证'}
              </small>
              <div className="row-actions">
                <Action
                  action={async () => setResult(await api(`/connections/${connection.id}/oauth`))}
                >
                  查看授权状态
                </Action>
                <Action
                  action={async () =>
                    setResult(
                      await api(`/connections/${connection.id}/oauth/start`, { method: 'POST' }),
                    )
                  }
                >
                  开始 / 重新授权
                </Action>
                <Action
                  danger
                  action={async () =>
                    setResult(
                      await api(`/connections/${connection.id}/oauth`, { method: 'DELETE' }),
                    )
                  }
                >
                  删除平台凭证
                </Action>
              </div>
              <Disclosure title="手动完成远程回调">
                <Form
                  label="提交完整回调地址"
                  submit={async (data) =>
                    setResult(
                      await api(`/connections/${connection.id}/oauth/complete`, {
                        method: 'POST',
                        body: json({ redirectUrl: value(data, 'redirectUrl') }),
                      }),
                    )
                  }
                >
                  <Field label="完整回调 URL" hint="包含 code 和 state；Pi 远程授权使用此入口">
                    <Input name="redirectUrl" type="url" required />
                  </Field>
                </Form>
              </Disclosure>
            </div>
          ))}
        {!connections.data?.length ? <Empty>先添加一个 MCP 连接。</Empty> : null}
      </Card>
      {result ? (
        <Card className="panel padded">
          <h2>授权响应</h2>
          <Code value={result} />
          <p>若返回 authorizationUrl，请复制到浏览器完成授权。</p>
        </Card>
      ) : null}
      <Card className="panel">
        <div className="panel-heading">
          <h2>Agent OAuth 授权</h2>
        </div>
        {grants.data?.length ? (
          grants.data.map((grant) => (
            <div className="row" key={grant.id}>
              <div className="grow">
                <code>{grant.profileId}</code>
                <small>
                  {grant.revoked ? '已撤销' : `访问令牌过期时间：${date(grant.expiresAt)}`}
                </small>
              </div>
              {!grant.revoked ? (
                <Action
                  danger
                  action={() => api(`/oauth/grants/${grant.id}`, { method: 'DELETE' })}
                >
                  撤销访问
                </Action>
              ) : null}
            </div>
          ))
        ) : (
          <Empty>尚无外部 Agent OAuth 授权。</Empty>
        )}
      </Card>
    </>
  );
}
