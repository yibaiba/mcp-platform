import { cliAuthorize } from '@platform/contracts';
import { authClient } from '../../lib/auth-client.js';
import { api, json } from '../../lib/api.js';
import { Card } from '../../components/ui/card.js';
import { Action, Feedback } from '../../components/shared/Controls.js';
export default function CliConsentPage() {
  const { data: session } = authClient.useSession();
  const input = Object.fromEntries(new URLSearchParams(window.location.search));
  const parsed = cliAuthorize.safeParse(input);
  if (!parsed.success)
    return (
      <Card className="panel padded">
        <h1>CLI 授权请求无效</h1>
        <Feedback error={new Error('请从 CLI 重新发起登录；回调、权限或 PKCE 参数无效。')} />
      </Card>
    );
  const cancel = new URL(parsed.data.redirect_uri);
  cancel.searchParams.set('error', 'access_denied');
  cancel.searchParams.set('state', parsed.data.state);
  return (
    <Card className="panel padded">
      <h1>允许 CLI 管理平台</h1>
      <p>
        平台：<strong>{window.location.origin}</strong>
      </p>
      <p>
        账号：<strong>{session?.user.email}</strong>
      </p>
      <ul>
        {parsed.data.scope.map((scope) => (
          <li key={scope}>
            {scope === 'management:read'
              ? '读取你有权访问的连接、配置和管理信息'
              : '创建和修改你有权管理的连接、配置及 Agent 密钥'}
          </li>
        ))}
      </ul>
      <p>
        授权不会扩大账号角色或资源权限。业务工具调用仍需独立 Agent 凭据。可在个人账号页随时撤销。
      </p>
      <p>回调：{parsed.data.redirect_uri}</p>
      <Action
        action={async () => {
          const result = await api<{ redirect: string }>('/cli/consent', {
            method: 'POST',
            body: json(input),
          });
          window.location.assign(result.redirect);
        }}
      >
        允许并返回 CLI
      </Action>
      <a className="cancel-link" href={cancel.toString()}>
        拒绝授权
      </a>
    </Card>
  );
}
