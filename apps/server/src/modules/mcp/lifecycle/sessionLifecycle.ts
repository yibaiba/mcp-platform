import type { ConnectionAdapter, ConnectionContext } from '../adapter.js';
import { AppError } from '../../../shared/errors.js';

type Managed = {
  context: ConnectionContext;
  leases: number;
  lastUsed: number;
  checking: boolean;
  nextCheck: number;
  timer?: NodeJS.Timeout;
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
  wrap(context: ConnectionContext, adapter: ConnectionAdapter): ConnectionAdapter {
    let current = adapter;
    let restoring: Promise<void> | undefined;
    let closed = false;
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
    const subscriptions = new Set<string>();
    const tick = async () => {
      if (closed || state.checking || state.leases > subscriptions.size) return;
      const idle = context.config.lifecycle.idleTimeoutMs;
      if (!state.leases && idle && Date.now() - state.lastUsed >= idle) {
        await this.effects.sleep(context);
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
        await this.effects.error(context, error);
        if (context.config.health.recover && !closed) {
          restoring = (async () => {
            unwatch();
            await current.close();
            const replacement = await this.effects.recover(context);
            if (closed) {
              await replacement.close();
              return;
            }
            current = replacement;
            unwatch = current.watch(notify);
            await current.catalog(AbortSignal.timeout(context.config.health.timeoutMs));
            for (const uri of subscriptions)
              await current.request({ method: 'resources/subscribe', params: { uri } });
            if (!closed) notify({ method: 'notifications/tools/list_changed' });
          })();
          try {
            await restoring;
          } finally {
            restoring = undefined;
          }
        }
      } finally {
        state.checking = false;
      }
    };
    const intervals = [
      context.config.lifecycle.idleTimeoutMs,
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
      catalog: (signal) => execute(() => current.catalog(signal)),
      call: (input) => execute(() => current.call(input)),
      check: (signal) =>
        execute(async () => {
          if (!current.check)
            throw new AppError('CHECK_UNSUPPORTED', '连接器需要升级以支持健康检查', 409);
          await current.check(signal);
        }),
      request: (operation, options) =>
        execute(async () => {
          const result = await current.request(operation, options);
          if (
            operation.method === 'resources/subscribe' &&
            !subscriptions.has(operation.params.uri)
          ) {
            subscriptions.add(operation.params.uri);
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
        clearInterval(state.timer);
        if (this.sessions.get(key) === state) this.sessions.delete(key);
        unwatch();
        await current.close();
      },
    };
  }
}
