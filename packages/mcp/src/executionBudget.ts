import type { Progress } from '@modelcontextprotocol/client';

type Policy = {
  readonly timeoutMs: number;
  readonly resetTimeoutOnProgress: boolean;
  readonly maxTotalTimeoutMs?: number;
};
type Clock = {
  now: () => number;
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clear: (timer: ReturnType<typeof setTimeout>) => void;
};
const clock: Clock = {
  now: () => performance.now(),
  schedule: (callback, delay) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer),
};
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** One budget survives every continuation; only active execution consumes it. */
export class ExecutionBudget {
  private readonly abort = new AbortController();
  private elapsed = 0;
  private started?: number;
  private lastProgress = -1;
  private idleUntil = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly policy: Policy,
    private readonly time: Clock = clock,
  ) {}
  get signal() {
    return this.abort.signal;
  }
  get remainingMs() {
    const active = this.started === undefined ? 0 : this.time.now() - this.started;
    return Math.max(
      0,
      (this.policy.maxTotalTimeoutMs ?? this.policy.timeoutMs) - this.elapsed - active,
    );
  }
  resume() {
    this.signal.throwIfAborted();
    if (this.started !== undefined) throw new Error('Execution budget is already running');
    this.started = this.time.now();
    this.lastProgress = -1;
    this.idleUntil = this.started + this.policy.timeoutMs;
    this.arm();
    this.signal.throwIfAborted();
  }
  pause() {
    if (this.timer !== undefined) this.time.clear(this.timer);
    this.timer = undefined;
    if (this.started !== undefined) this.elapsed += this.time.now() - this.started;
    this.started = undefined;
  }
  progress(value: Progress) {
    if (this.started === undefined || this.signal.aborted) return;
    if (
      !Number.isFinite(value.progress) ||
      value.progress < 0 ||
      value.progress <= this.lastProgress
    )
      return;
    if (
      value.total !== undefined &&
      (!Number.isFinite(value.total) || value.total < value.progress)
    )
      return;
    this.lastProgress = value.progress;
    if (!this.policy.resetTimeoutOnProgress) return;
    // Progress arriving after expiry cannot revive an exhausted budget.
    if (this.time.now() >= this.idleUntil || this.remainingMs <= 0) return this.expire();
    this.idleUntil = this.time.now() + this.policy.timeoutMs;
    this.arm();
  }
  private expire() {
    this.pause();
    this.abort.abort(new Error('MCP execution timed out; upstream result may be unknown'));
  }
  private arm() {
    if (this.timer !== undefined) this.time.clear(this.timer);
    const remaining = Math.min(this.remainingMs, this.idleUntil - this.time.now());
    if (remaining <= 0) return this.expire();
    this.timer = this.time.schedule(() => this.arm(), Math.min(remaining, MAX_TIMER_DELAY_MS));
  }
}
