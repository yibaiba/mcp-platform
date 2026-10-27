import { Card } from '../../components/ui/card.js';
import { useQuery } from '@tanstack/react-query';
import { api, json, type Profile } from '../../lib/api.js';
import { Action, Code, Feedback } from '../../components/shared/Controls.js';
export default function ConsentPage() {
  const input = Object.fromEntries(new URLSearchParams(window.location.search));
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<Profile[]>('/profiles') });
  const id = input.resource?.split('/mcp/')[1];
  const profile = profiles.data?.find((p) => p.id === id);
  return (
    <Card className="panel padded">
      <h1>允许 Agent 接入</h1>
      <Feedback error={profiles.error} />
      <p>授权后，该客户端可以调用配置「{profile?.name ?? id}」当前及后续获准访问的工具。</p>
      <Code
        value={{
          clientId: input.client_id,
          redirectUri: input.redirect_uri,
          resource: input.resource,
          scope: input.scope ?? 'mcp',
        }}
      />
      <p>{profile?.toolIds.length ?? 0} 个获准工具。可随时在授权页面撤销。</p>
      <Action
        action={async () => {
          const result = await api<{ redirect: string }>('/oauth/consent', {
            method: 'POST',
            body: json(input),
          });
          window.location.assign(result.redirect);
        }}
      >
        允许并返回客户端
      </Action>
      <a className="cancel-link" href="/">
        取消授权
      </a>
    </Card>
  );
}
