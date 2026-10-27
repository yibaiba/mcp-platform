type Lease = { release: () => void };
/** Workers share Pi's encrypted authorization file, but retain distinct MCP sessions. */
export class AuthorizationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  async acquire(key: string, signal: AbortSignal): Promise<Lease> {
    signal.throwIfAborted();
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      await Promise.race([previous, cancelled]);
      signal.throwIfAborted();
      return { release };
    } catch (error) {
      release();
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
}
export const authorizationCoordinator = new AuthorizationCoordinator();
