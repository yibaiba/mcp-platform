import { AppError } from '../../../shared/errors.js';

const JITTER = 0.2;
export type RecoveryState = {
  readonly attempts: number;
  readonly status: 'idle' | 'scheduled' | 'recovering' | 'blocked';
  readonly nextAt?: string;
  readonly error?: string;
};

function retryable(error: unknown) {
  if (error instanceof AppError && error.status < 500) return false;
  if (!(error instanceof Error)) return true;
  if (error.cause && !retryable(error.cause)) return false;
  if (['UnauthorizedError', 'ZodError', 'McpValidationError'].includes(error.name)) return false;
  return !(
    'code' in error &&
    ['ENOENT', 'EACCES', 'EINVAL', 'MCP_SCHEMA_VALIDATION', 'auth_required'].includes(
      String(error.code),
    )
  );
}

/** Retries connection establishment only; never accepts an invocation to replay. */
export class RecoverySchedule {
  private timer?: NodeJS.Timeout;
  private closed = false;
  private nextDelay: number;
  private value: RecoveryState = { attempts: 0, status: 'idle' };
  constructor(
    private readonly options: {
      initialIntervalMs: number;
      maxIntervalMs: number;
      recover: () => Promise<void>;
      report: (error: unknown) => Promise<void>;
      redact: (error: unknown) => string;
      random?: () => number;
    },
  ) {
    this.nextDelay = options.initialIntervalMs;
  }
  get state() {
    return this.value;
  }
  failed(error: unknown) {
    if (this.closed) return;
    const message = this.options.redact(error);
    if (!retryable(error)) {
      clearTimeout(this.timer);
      this.value = { ...this.value, status: 'blocked', nextAt: undefined, error: message };
      return;
    }
    if (this.value.status === 'scheduled' || this.value.status === 'recovering') return;
    const jitter = 1 + ((this.options.random ?? Math.random)() * 2 - 1) * JITTER;
    const delay = Math.min(this.options.maxIntervalMs, this.nextDelay * jitter);
    this.nextDelay = Math.min(this.nextDelay * 2, this.options.maxIntervalMs);
    this.value = {
      ...this.value,
      status: 'scheduled',
      error: message,
      nextAt: new Date(Date.now() + delay).toISOString(),
    };
    this.timer = setTimeout(() => {
      void this.run();
    }, delay).unref();
  }
  succeeded() {
    clearTimeout(this.timer);
    this.nextDelay = this.options.initialIntervalMs;
    this.value = { attempts: 0, status: 'idle' };
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
  private async run() {
    if (this.closed) return;
    this.value = {
      ...this.value,
      attempts: this.value.attempts + 1,
      status: 'recovering',
      nextAt: undefined,
    };
    try {
      await this.options.recover();
      if (!this.closed) this.succeeded();
    } catch (error) {
      if (this.closed) return;
      this.value = { ...this.value, status: 'idle' };
      this.failed(error);
      try {
        await this.options.report(error);
      } catch (reportError) {
        console.error('Recovery error persistence failed', this.options.redact(reportError));
      }
    }
  }
}
