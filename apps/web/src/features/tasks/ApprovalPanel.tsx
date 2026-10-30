import { useQuery } from '@tanstack/react-query';
import { api, json } from '../../lib/api.js';
import { Card } from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
import { usePermissionLabels } from './permissionLabels.js';
import {
  Action,
  Code,
  Feedback,
  Field,
  Form,
  Status,
  value,
} from '../../components/shared/Controls.js';
type Permissions = { toolIds: string[]; contentIds: string[]; artifactIds: string[] };
type Request = {
  id: string;
  profileId: string;
  taskId?: string;
  subject: string;
  requested: Permissions;
  approved?: Permissions;
  reason: string;
  status: string;
  deadline?: string;
};
export function ApprovalPanel({ profileId, taskId }: { profileId?: string; taskId?: string }) {
  const labels = usePermissionLabels();
  const requests = useQuery({
    queryKey: ['permission-requests'],
    queryFn: () => api<Request[]>('/permission-requests'),
    refetchInterval: 3000,
  });
  const grants = useQuery({
    queryKey: ['temporary-grants'],
    queryFn: () =>
      api<
        {
          id: string;
          profileId: string;
          taskId?: string;
          subject: string;
          permissions: Permissions;
          expiresAt: string;
          revokedAt?: string;
        }[]
      >('/temporary-grants'),
    refetchInterval: 3000,
  });
  const relevant = (row: { profileId: string; taskId?: string }) =>
    (!profileId || row.profileId === profileId) && (!taskId || row.taskId === taskId);
  return (
    <Card className="panel padded">
      <h2>平台权限审批</h2>
      <p>与上游补充信息请求分开。批准只更新权限；业务工具须另行调用。</p>
      <Feedback error={requests.error ?? grants.error ?? labels.error} />
      {requests.data?.filter(relevant).map((request) => (
        <section className="connection-row" key={request.id}>
          <Status value={request.status} />
          <h3>{request.reason}</h3>
          <small>
            {request.subject} · Agent {request.profileId}
            {request.deadline ? ` · 申请截止 ${request.deadline}` : ''}
          </small>
          {request.status === 'pending' ? (
            <>
              <Form
                label="批准所选子集"
                submit={(data) =>
                  api(`/permission-requests/${request.id}/decide`, {
                    method: 'POST',
                    body: json({
                      decision: 'approved',
                      permissions: {
                        toolIds: data.getAll('toolIds'),
                        contentIds: data.getAll('contentIds'),
                        artifactIds: data.getAll('artifactIds'),
                      },
                      expiresAt: value(data, 'expiresAt')
                        ? new Date(value(data, 'expiresAt')).toISOString()
                        : undefined,
                    }),
                  })
                }
              >
                {(Object.keys(request.requested) as (keyof Permissions)[]).map((kind) => (
                  <fieldset key={kind}>
                    <legend>
                      {
                        {
                          toolIds: '工具',
                          contentIds: 'Prompt / Resource / 模板',
                          artifactIds: '文件',
                        }[kind]
                      }
                    </legend>
                    {request.requested[kind].map((id) => (
                      <CheckChoice key={id} name={kind} value={id}>
                        <span>
                          {labels.label(id)}
                          <small>{id}</small>
                        </span>
                      </CheckChoice>
                    ))}
                  </fieldset>
                ))}
                <Field label="授权到期时间（默认一小时）">
                  <Input name="expiresAt" type="datetime-local" />
                </Field>
              </Form>
              <div className="row-actions">
                <Action
                  action={() =>
                    api(`/permission-requests/${request.id}/decide`, {
                      method: 'POST',
                      body: json({ decision: 'rejected' }),
                    })
                  }
                >
                  拒绝
                </Action>
                <Action
                  action={() =>
                    api(`/permission-requests/${request.id}/decide`, {
                      method: 'POST',
                      body: json({ decision: 'cancelled' }),
                    })
                  }
                >
                  取消申请
                </Action>
              </div>
            </>
          ) : (
            <Code value={request.approved ?? request.requested} />
          )}
        </section>
      ))}
      <h3>临时授权</h3>
      {grants.data?.filter(relevant).map((grant) => (
        <section className="connection-row" key={grant.id}>
          <small>
            {grant.subject} · 到期 {grant.expiresAt} ·{' '}
            {grant.revokedAt ? '已撤销' : '按当前策略持续校验'}
          </small>
          <Code value={grant.permissions} />
          {!grant.revokedAt ? (
            <Action
              danger
              confirmation={{
                title: '撤销此临时授权？',
                description: '任务将无法继续使用这些权限。',
                confirmLabel: '撤销',
              }}
              action={() => api(`/temporary-grants/${grant.id}`, { method: 'DELETE' })}
            >
              撤销此临时授权
            </Action>
          ) : null}
        </section>
      ))}
    </Card>
  );
}
