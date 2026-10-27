const CHECKPOINT_INTERVAL_MS = 200;

// Keep one write in flight and coalesce text deltas; a slow database cannot build an unbounded queue.
export class OutputCheckpoint {
  private latest?: string;
  private writing?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private failure?: unknown;
  constructor(
    private readonly deps: {
      write: (text: string) => Promise<unknown>;
      failed: (error: unknown) => void;
    },
  ) {}

  append(text: string) {
    this.latest = text;
    if (this.timer || this.writing || this.failure) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(this.deps.failed);
    }, CHECKPOINT_INTERVAL_MS);
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.writing) await this.writing;
    if (this.failure) throw this.failure;
    if (this.latest === undefined) return;
    const snapshot = this.latest;
    this.latest = undefined;
    this.writing = this.deps.write(snapshot).then(() => {});
    try {
      await this.writing;
    } catch (error) {
      this.failure = error;
      throw error;
    } finally {
      this.writing = undefined;
    }
    if (this.latest !== undefined) await this.flush();
  }
}
