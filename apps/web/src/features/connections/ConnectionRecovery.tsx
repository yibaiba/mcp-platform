import type { Connection } from '../../lib/api.js';

export function ConnectionRecovery({ connection }: { connection: Connection }) {
  return connection.recovery
    ?.filter((state) => state.status !== 'idle')
    .map((state, index) => (
      <div
        key={`${state.sessionId}-${index}`}
        role="status"
        className="mt-3 space-y-1 text-xs text-muted-foreground"
      >
        <p>
          自动恢复：
          {state.status === 'blocked'
            ? '待配置或授权'
            : state.status === 'recovering'
              ? '正在尝试'
              : '等待重试'}
          {' · '}已尝试 {state.attempts} 次
          {state.nextAt ? ` · 下次 ${new Date(state.nextAt).toLocaleString()}` : ''}
        </p>
        {state.error ? <p className="break-words text-destructive">{state.error}</p> : null}
      </div>
    ));
}
