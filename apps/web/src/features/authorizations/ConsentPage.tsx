import { Card } from '../../components/ui/card.js';
import { useQuery } from '@tanstack/react-query';
import { api, json } from '../../lib/api.js';
import { Action, Code, Feedback, ListSkeleton } from '../../components/shared/Controls.js';
import { Disclosure } from '../../components/shared/Disclosure.js';

type ConsentDetails = {
  clientName: string;
  redirectUri: string;
  profile: { id: string; name: string };
  tools: { name: string; description?: string; unavailable: boolean }[];
};
export default function ConsentPage() {
  const search = window.location.search;
  const input = Object.fromEntries(new URLSearchParams(search));
  const details = useQuery({
    queryKey: ['oauth-consent', search],
    queryFn: () => api<ConsentDetails>(`/oauth/consent${search}`),
  });
  const data = details.data;
  return (
    <Card className="panel padded">
      <h1>允许「{data?.clientName ?? '客户端'}」接入 Agent</h1>
      <Feedback error={details.error} />
      {details.isPending ? <ListSkeleton rows={3} /> : null}
      {data ? (
        <>
          <p>
            授权后，「{data.clientName}」可以调用 Agent「{data.profile.name}
            」当前及以后获准的工具。随时可在「授权」页面撤销。
          </p>
          <h2 className="text-sm">现在可用的 {data.tools.length} 个工具</h2>
          {data.tools.length ? (
            <ul className="consent-tools">
              {data.tools.map((tool) => (
                <li key={tool.name}>
                  <code>{tool.name}</code>
                  {tool.unavailable ? <small>（暂不可用）</small> : null}
                  {tool.description ? <small> · {tool.description}</small> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">这个 Agent 还没有获准的工具。</p>
          )}
        </>
      ) : null}
      <Disclosure title="技术详情">
        <Code
          value={{
            clientId: input.client_id,
            redirectUri: input.redirect_uri,
            resource: input.resource,
            scope: input.scope ?? 'mcp',
          }}
        />
      </Disclosure>
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
