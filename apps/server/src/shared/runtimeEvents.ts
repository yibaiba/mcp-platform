import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { owner, type ApiEnv } from './http.js';

type RuntimeEvent = Readonly<{
  ownerId: string;
  kind: 'call' | 'task';
  id: string;
  status?: string;
  revision?: number;
  text?: string;
  error?: string;
}>;
export class RuntimeEvents {
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  publish(event: RuntimeEvent) {
    for (const listener of this.listeners) listener(event);
  }
  routes() {
    const app = new Hono<ApiEnv>();
    for (const [path, kind] of [
      ['/calls/events', 'call'],
      ['/tasks/events', 'task'],
    ] as const)
      app.get(path, (c) => {
        const ownerId = owner(c);
        return streamSSE(c, async (stream) => {
          let writes = Promise.resolve();
          let failed!: (error: unknown) => void;
          const failure = new Promise<never>((_, reject) => {
            failed = reject;
          });
          const listener = (event: RuntimeEvent) => {
            if (event.ownerId !== ownerId || event.kind !== kind) return;
            const { ownerId: _owner, ...data } = event;
            writes = writes.then(() =>
              stream.writeSSE({ event: kind, data: JSON.stringify(data) }),
            );
            void writes.catch(failed);
          };
          this.listeners.add(listener);
          let cleanup = () => {};
          const aborted = new Promise<void>((resolve) => {
            cleanup = resolve;
            stream.onAbort(resolve);
          });
          try {
            await stream.writeSSE({ event: 'ready', data: JSON.stringify({ kind }) });
            await Promise.race([aborted, failure]);
          } finally {
            this.listeners.delete(listener);
            cleanup();
          }
        });
      });
    return app;
  }
}
