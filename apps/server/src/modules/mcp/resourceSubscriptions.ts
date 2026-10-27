import { currentExecution } from './executionContext.js';
import type { ContentAccess, ContentService } from './contentService.js';

type Subscription = {
  connectionId: string;
  channels: Set<string>;
  release: () => Promise<unknown>;
};
export class ResourceSubscriptions {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly changes = new Map<string, Promise<unknown>>();
  constructor(private readonly content: ContentService) {}
  async subscribe(input: {
    access: ContentAccess;
    channel: string;
    uri: string;
    signal?: AbortSignal;
    active?: () => boolean;
  }) {
    const { entry, original } = await this.content.resolveResource(input.access, input.uri);
    const key = `${entry.connectionId}:${currentExecution()?.identity ?? 'default'}:${currentExecution()?.sessionId ?? 'dashboard'}:${original}`;
    await this.sequence(key, async () => {
      input.signal?.throwIfAborted();
      if (input.active && !input.active()) throw new Error('订阅入口已关闭');
      let subscription = this.subscriptions.get(key);
      if (!subscription) {
        const release = await this.content.subscribe(entry, original, () => {
          void this.sequence(key, async () => {
            const previous = this.subscriptions.get(key);
            this.subscriptions.delete(key);
            await previous?.release();
          }).catch((error: unknown) =>
            console.error('Subscription permission cleanup failed', error),
          );
        });
        subscription = {
          connectionId: entry.connectionId,
          channels: new Set(),
          release,
        };
        this.subscriptions.set(key, subscription);
      }
      try {
        await this.content.resolveResource(input.access, input.uri);
        input.signal?.throwIfAborted();
        if (input.active && !input.active()) throw new Error('订阅入口已关闭');
        subscription.channels.add(`${input.channel}:${input.uri}`);
      } catch (error) {
        if (!subscription.channels.size) {
          this.subscriptions.delete(key);
          await subscription.release();
        }
        throw error;
      }
    });
  }
  has(channel: string, uri: string) {
    return [...this.subscriptions.values()].some((subscription) =>
      subscription.channels.has(`${channel}:${uri}`),
    );
  }
  includesConnection(channel: string, connectionId: string) {
    return [...this.subscriptions.values()].some(
      (subscription) =>
        subscription.connectionId === connectionId &&
        [...subscription.channels].some((claim) => claim.startsWith(`${channel}:`)),
    );
  }
  async release(channel: string, uri?: string) {
    const claims = uri ? `${channel}:${uri}` : `${channel}:`;
    for (const key of this.subscriptions.keys()) {
      await this.sequence(key, async () => {
        const subscription = this.subscriptions.get(key);
        if (!subscription) return;
        for (const claim of subscription.channels) {
          if (uri ? claim === claims : claim.startsWith(claims))
            subscription.channels.delete(claim);
        }
        if (subscription.channels.size) return;
        this.subscriptions.delete(key);
        await subscription.release();
      });
    }
  }
  private async sequence(key: string, action: () => Promise<void>) {
    const previous = this.changes.get(key) ?? Promise.resolve();
    const pending = previous.then(action, action);
    this.changes.set(key, pending);
    try {
      await pending;
    } finally {
      if (this.changes.get(key) === pending) this.changes.delete(key);
    }
  }
}
