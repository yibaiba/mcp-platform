import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { Action, Code, date, Feedback, Status } from '../../components/shared/Controls.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { api, type Call } from '../../lib/api.js';
import {
  callDuration,
  callEntry,
  callLocation,
  callPhase,
  type CallNames,
} from './callPresentation.js';
export function CallDetail({
  id,
  names,
  onClose,
}: {
  id: string;
  names: CallNames;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ['call', id],
    queryFn: ({ signal }) => api<Call>(`/calls/${id}`, { signal }),
    refetchInterval: (state) =>
      ['running', 'waiting'].includes(state.state.data?.status ?? '') ? 5000 : false,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>调用详情</DialogTitle>
          <DialogDescription>查看此次调用的身份、执行位置和诊断信息。</DialogDescription>
        </DialogHeader>
        <Feedback error={query.error} />
        {query.isPending ? <p role="status">正在读取调用记录…</p> : null}
        {query.data ? <CallInformation call={query.data} names={names} /> : null}
      </DialogContent>
    </Dialog>
  );
}
function CallInformation({ call, names }: { call: Call; names: CallNames }) {
  const rows = [
    ['工具', names.tools.get(call.toolId) ?? call.toolId],
    ['Agent', call.profileId ? (names.profiles.get(call.profileId) ?? call.profileId) : '管理账号'],
    ['连接', names.connections.get(call.connectionId) ?? call.connectionId],
    ['执行位置', callLocation(call, names)],
    ['调用入口', callEntry(call.entry)],
    ['执行阶段', callPhase(call.phase)],
    ['开始时间', date(call.startedAt)],
    ['结束时间', call.endedAt ? date(call.endedAt) : '尚未结束'],
    ['耗时', callDuration(call)],
  ];
  return (
    <div className="space-y-4">
      <Status value={call.status} />
      {call.error ? (
        <p className="error" role="alert">
          {call.error}
        </p>
      ) : null}
      {call.status === 'unknown' ? (
        <p>上游可能已执行。请检查实际结果，再决定是否发起新调用。</p>
      ) : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2">
        {rows.map(([label, text]) => (
          <div className="contents" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-all">{text}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-4">
        <Link to="/tools" search={{ profileId: call.profileId ?? undefined, toolId: call.toolId }}>
          查看工具
        </Link>
        {call.profileId ? (
          <a href={`/profiles?workspace=${encodeURIComponent(call.profileId)}`}>Agent 工作空间</a>
        ) : null}
        {call.taskId ? (
          <a href={`/tasks?task=${encodeURIComponent(call.taskId)}`}>关联任务</a>
        ) : null}
        {['running', 'waiting'].includes(call.status) ? (
          <Action action={() => api(`/calls/${call.id}/cancel`, { method: 'POST' })}>
            请求取消此次调用
          </Action>
        ) : null}
      </div>
      <Disclosure title="关联标识与原始诊断">
        <Code
          value={{
            callId: call.id,
            toolId: call.toolId,
            profileId: call.profileId,
            taskId: call.taskId,
            connectionId: call.connectionId,
            deviceId: call.deviceId,
            bindingId: call.bindingId,
            credentialId: call.credentialId,
            correlationId: call.correlationId,
            adapter: call.adapter,
            entry: call.entry,
            phase: call.phase,
            revision: call.revision,
          }}
        />
      </Disclosure>
    </div>
  );
}
