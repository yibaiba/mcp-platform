import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Card } from '../../components/ui/card.js';
import { Action, date, Feedback } from '../../components/shared/Controls.js';
type Grant = {
  id: string;
  scopes: string[];
  revoked: boolean;
  createdAt: string;
  refreshExpiresAt: string;
};
export function CliGrants() {
  const query = useQuery({ queryKey: ['cli-grants'], queryFn: () => api<Grant[]>('/cli/grants') });
  return (
    <Card className="panel padded">
      <h2>CLI 管理授权</h2>
      <p>
        access token 有效期 1 小时，刷新凭据轮换且授权最长 30 天；撤销后不能继续刷新或管理平台。
      </p>
      <Feedback error={query.error} />
      {query.isPending ? <p>正在读取授权…</p> : null}
      {query.data?.length === 0 ? <p>尚无 CLI 授权。</p> : null}
      {query.data?.map((grant) => (
        <div key={grant.id} className="panel padded">
          <p>
            {grant.scopes.join('、')} · {grant.revoked ? '已撤销' : '已授权'}
          </p>
          <small>
            {date(grant.createdAt)} — {date(grant.refreshExpiresAt)}
          </small>
          {!grant.revoked ? (
            <Action
              danger
              action={async () => {
                await api(`/cli/grants/${grant.id}`, { method: 'DELETE' });
                await query.refetch();
              }}
            >
              撤销 CLI 授权
            </Action>
          ) : null}
        </div>
      ))}
    </Card>
  );
}
