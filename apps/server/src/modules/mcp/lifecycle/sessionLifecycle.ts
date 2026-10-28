import type { ConnectionAdapter, ConnectionContext } from '../adapter.js';
import { RecoverySchedule } from './recoverySchedule.js';
import { redactConnectionError } from '../connectionDiagnostics.js';
import { AppError } from '../../../shared/errors.js';
import { withRequestBudget } from '@platform/mcp';

type Managed = {
  context: ConnectionContext;
  leases: number;
  lastUsed: number;
  checking: boolean;
  nextCheck: number;
  timer?: NodeJS.Timeout;
  recovery?: RecoverySchedule;
};
export class SessionLifecycle {
  private readonly sessions = new Map<string, Managed>();
  constructor(
    private readonly effects: {
      sleep: (context: ConnectionContext) => Promise<void>;
      error: (context: ConnectionContext, error: unknown) => Promise<void>;
      recover: (context: ConnectionContext) => Promise<ConnectionAdapter>;
    },
  ) {}
  hold(key: string) {
    const state = this.sessions.get(key);
    if (!state) throw new AppError('SESSION_ENDED', '运行会话已结束', 409);
    state.leases++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        state.leases--;
        state.lastUsed = Date.now();
      }
    };
  }
  busy(connectionId: string) {
    return [...this.sessions.values()].some(
      (s) => s.context.id === connectionId && (s.leases > 0 || s.checking),
    );
  }
  recovery(connectionId: string) {
    return [...this.sessions.values()]
      .filter((state) => state.context.id === connectionId && state.recovery)
      .map((state) => ({ sessionId: state.context.sessionId, ...state.recovery!.state }));
  }
  wrap(
    context: ConnectionContext,
    adapter: ConnectionAdapter,
    signal?: AbortSignal,
  ): ConnectionAdapter {
    let current = adapter;
    let restoring: Promise<void> | undefined;
    let closed = false;
    const lifetime = new AbortController();
    const listeners = new Set<Parameters<ConnectionAdapter['watch']>[0]>();
    const notify: Parameters<ConnectionAdapter['watch']>[0] = (event) => {
      for (const listener of listeners) listener(event);
    };
    let unwatch = current.watch(notify);
    const key = context.runtimeKey ?? context.id;
    const state: Managed = {
      context,
      leases: 0,
      lastUsed: Date.now(),
      checking: false,
      nextCheck: Date.now() + context.config.health.intervalMs,
    };
    this.sessions.set(key, state);
    const execute = async <T>(action: () => Promise<T>) => {
      if (restoring) await restoring;
      if (closed) throw new AppError('SESSION_ENDED', '运行会话已结束', 409);
      state.leases++;
      try {
        return await action();
      } finally {
        state.leases--;
        state.lastUsed = Date.now();
      }
    };
    const subscriptions = new Map<string, AbortSignal | undefined>();
    const restore = async () => {
      unwatch();
      await current.close();
      const replacement = await this.effects.recover(context);
      if (closed || signal?.aborted) {
        await replacement.close();
        return;
      }
      current = replacement;
      unwatch = current.watch(notify);
      const recoverySignal = AbortSignal.any([
        lifetime.signal,
        ...(signal ? [signal] : []),
        AbortSignal.timeout(context.config.connectTimeoutMs),
      ]);
      await current.catalog(recoverySignal);
      for (const [uri, subscriptionSignal] of subscriptions) {
        if (subscriptionSignal?.aborted) continue;
        recoverySignal.throwIfAborted();
        await current.request(
          { method: 'resources/subscribe', params: { uri } },
          {
            signal: AbortSignal.any([
              recoverySignal,
              ...(subscriptionSignal ? [subscriptionSignal] : []),
            ]),
          },
        );
      }
      if (!closed) notify({ method: 'notifications/tools/list_changed' });
    };
    if (context.config.health.recover)
      state.recovery = new RecoverySchedule({
        ...context.config.health,
        redact: (error) => redactConnectionError(error, context.config),
        report: (error) => this.effects.error(context, error),
        recover: async () => {
          restoring = restore();
          try {
            await restoring;
          } finally {
            restoring = undefined;
          }
        },
      });
    const cancel = () => {
      state.recovery?.close();
      clearInterval(state.timer);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const tick = async () => {
      if (closed || state.checking || state.leases > subscriptions.size) return;
      if (state.recovery && state.recovery.state.status !== 'idle') return;
      const idle = context.config.lifecycle.idleTimeoutMs;
      if (!state.leases && idle && Date.now() - state.lastUsed >= idle) {
        await this.effects.sleep(context);
        return;
      }
      if (current.status() === 'disconnected' && state.recovery) {
        state.recovery.failed(new Error('MCP session disconnected'));
        return;
      }
      if (!context.config.health.enabled || Date.now() < state.nextCheck) return;
      state.checking = true;
      state.nextCheck = Date.now() + context.config.health.intervalMs;
      try {
        if (!current.check)
          throw new AppError('CHECK_UNSUPPORTED', '连接器需要升级以支持健康检查', 409);
        await current.check(AbortSignal.timeout(context.config.health.timeoutMs));
      } catch (error) {
        if (closed || signal?.aborted) return;
        await this.effects.error(context, error);
        state.recovery?.failed(error);
      } finally {
        state.checking = false;
      }
    };
    const intervals = [
      context.config.lifecycle.idleTimeoutMs,
      context.config.health.recover ? context.config.health.initialIntervalMs : undefined,
      context.config.health.enabled ? context.config.health.intervalMs : undefined,
    ].filter((value): value is number => value !== undefined);
    if (intervals.length)
      state.timer = setInterval(
        () => {
          void tick().catch((error: unknown) => this.effects.error(context, error));
        },
        Math.min(...intervals),
      ).unref();
    return {
      ...adapter,
      status: () => current.status(),
      watch(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      discover: (signal) => execute(() => current.discover(signal)),
      catalog: (signal) =>
        execute(async () => {
          try {
            const catalog = await current.catalog(signal);
            state.recovery?.succeeded();
            return catalog;
          } catch (error) {
            if (!signal?.aborted) state.recovery?.failed(error);
            throw error;
          }
        }),
      call: (input) => execute(() => current.call(input)),
      check: (signal) =>
        execute(async () => {
          if (!current.check)
            throw new AppError('CHECK_UNSUPPORTED', '连接器需要升级以支持健康检查', 409);
          await current.check(signal);
        }),
      request: (operation, options) =>
        execute(async () => {
          const result = await withRequestBudget({
            policy: context.config.requestOptions,
            options: {
              ...options,
              signal: AbortSignal.any([
                lifetime.signal,
                ...(signal && operation.method !== 'resources/unsubscribe' ? [signal] : []),
                ...(options?.signal ? [options.signal] : []),
              ]),
            },
            execute: (budget) => current.request(operation, budget),
          });
          if (
            operation.method === 'resources/subscribe' &&
            !subscriptions.has(operation.params.uri)
          ) {
            subscriptions.set(operation.params.uri, options?.signal);
            state.leases++;
          }
          if (
            operation.method === 'resources/unsubscribe' &&
            subscriptions.delete(operation.params.uri)
          )
            state.leases--;
          return result;
        }),
      close: async () => {
        closed = true;
        lifetime.abort(new Error('Session closed'));
        cancel();
        signal?.removeEventListener('abort', cancel);
        if (this.sessions.get(key) === state) this.sessions.delete(key);
        unwatch();
        await current.close();
      },
    };
  }
}
