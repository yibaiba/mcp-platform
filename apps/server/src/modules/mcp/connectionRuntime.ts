import type { ConnectionAdapter, ConnectionContext } from './adapter.js';

type AdapterOutcome = { adapter: ConnectionAdapter } | { error: unknown };
export type ConnectionSlot = {
  readonly id: string;
  readonly profileId?: string;
  readonly context?: Pick<
    ConnectionContext,
    | 'id'
    | 'ownerId'
    | 'profileId'
    | 'bindingId'
    | 'sessionId'
    | 'identity'
    | 'shareId'
    | 'credentialScope'
  > & { readonly deviceId?: string };
  readonly abort: AbortController;
  readonly ready?: Promise<AdapterOutcome>;
};

// Slot identity prevents late work from replacing a newer connection's state.
export class ConnectionRuntime {
  private readonly slots = new Map<string, ConnectionSlot>();
  private readonly writes = new Map<string, Promise<unknown>>();
  constructor(
    private readonly factory: (
      context: ConnectionContext,
      slot: ConnectionSlot,
    ) => Promise<ConnectionAdapter>,
  ) {}

  acquire(context: ConnectionContext): ConnectionSlot {
    const key = context.runtimeKey ?? context.id;
    const current = this.slots.get(key);
    if (current?.ready) return current;
    const slot: ConnectionSlot = {
      id: key,
      profileId: context.profileId,
      context: {
        id: context.id,
        ownerId: context.ownerId,
        profileId: context.profileId,
        bindingId: context.bindingId,
        sessionId: context.sessionId,
        identity: context.identity,
        shareId: context.shareId,
        credentialScope: context.credentialScope,
        deviceId: context.config.deviceId,
      },
      abort: new AbortController(),
      ready: this.sequence(key, () => this.factory(context, slot)).then<
        AdapterOutcome,
        AdapterOutcome
      >(
        (adapter) => ({ adapter }),
        (error: unknown) => ({ error }),
      ),
    };
    this.slots.set(key, slot);
    return slot;
  }

  current(slot: ConnectionSlot) {
    return this.slots.get(slot.id) === slot;
  }

  invalidate(id: string) {
    const previous = this.slots.get(id);
    const next = { id, abort: new AbortController() };
    this.slots.set(id, next);
    previous?.abort.abort(new Error('连接已停止或被替换'));
    const closed = this.sequence(id, () => this.close(previous));
    return { next, closed };
  }

  async adapter(slot: ConnectionSlot) {
    const outcome = await slot.ready;
    if (!outcome) throw new Error('连接运行时尚未创建');
    if ('error' in outcome) throw outcome.error;
    return outcome.adapter;
  }

  async status(id: string) {
    const outcome = await this.slots.get(id)?.ready;
    return outcome && 'adapter' in outcome ? outcome.adapter.status() : 'disconnected';
  }

  private async close(slot?: ConnectionSlot) {
    const outcome = await slot?.ready;
    // A failed factory has no adapter to close; adapter() exposes its error.
    if (outcome && 'adapter' in outcome) await outcome.adapter.close();
  }

  async write(slot: ConnectionSlot, action: () => Promise<unknown>) {
    return this.sequence(slot.id, async () => {
      if (!this.current(slot)) return false;
      await action();
      return true;
    });
  }

  private async sequence<T>(id: string, action: () => Promise<T>) {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const pending = previous.then(action, action);
    this.writes.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.writes.get(id) === pending) this.writes.delete(id);
    }
  }

  keysForProfile(profileId: string) {
    return [...this.slots.values()].filter((s) => s.profileId === profileId).map((s) => s.id);
  }
  keysForShare(shareId: string) {
    return [...this.slots.values()]
      .filter((slot) => slot.context?.shareId === shareId)
      .map((slot) => slot.id);
  }
  keysForOwner(ownerId: string) {
    return [...this.slots.values()]
      .filter((slot) => slot.context?.ownerId === ownerId)
      .map((slot) => slot.id);
  }
  keysForCredentialBinding(bindingId: string) {
    return [...this.slots.values()]
      .filter((slot) => slot.context?.credentialScope?.bindingId === bindingId)
      .map((slot) => slot.id);
  }
  sessions(ownerId: string) {
    return [...this.slots.values()]
      .filter(
        (slot) => slot.ready && !slot.abort.signal.aborted && slot.context?.ownerId === ownerId,
      )
      .map((slot) => slot.context!);
  }
  keys(connectionId: string) {
    return [...this.slots.keys()].filter(
      (key) =>
        this.slots.get(key)?.ready && (key === connectionId || key.startsWith(`${connectionId}:`)),
    );
  }

  async shutdown() {
    const slots = [...this.slots.values()];
    const outcomes = await Promise.allSettled(slots.map((slot) => this.invalidate(slot.id).closed));
    const errors = outcomes
      .filter((outcome) => outcome.status === 'rejected')
      .map((outcome) => outcome.reason);
    if (errors.length) throw new AggregateError(errors, '关闭 MCP 连接失败');
  }
}
