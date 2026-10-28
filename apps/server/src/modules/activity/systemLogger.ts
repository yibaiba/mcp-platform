import { systemLogs, type Database } from '@platform/db';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
const code = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/);
export const logInput = z
  .object({
    level: z.enum(['info', 'warn', 'error']),
    event: z.enum([
      'http_request',
      'server_started',
      'server_stopped',
      'retention_cleanup',
      'retention_failed',
      'runtime_failure',
    ]),
    ownerId: z.string().optional(),
    code: code.optional(),
    method: z
      .enum([
        'GET',
        'POST',
        'PUT',
        'PATCH',
        'DELETE',
        'HEAD',
        'OPTIONS',
        'CONNECT',
        'TRACE',
        'OTHER',
      ])
      .optional(),
    route: z.string().optional(),
    status: z.number().int().optional(),
    durationMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type LogInput = z.infer<typeof logInput>;
export type LogEntry = typeof systemLogs.$inferSelect;

export class SystemLogger {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly failures: unknown[] = [];
  private readonly listeners = new Set<(entry: LogEntry) => void>();
  constructor(
    private readonly effects: {
      persist: (input: LogInput) => Promise<LogEntry>;
      stdout: (line: string) => void;
      stderr: (line: string) => void;
    },
  ) {}
  async write(input: LogInput) {
    const value = logInput.parse(input);
    let record;
    try {
      record = await this.effects.persist(value);
    } catch (error) {
      this.effects.stderr(
        JSON.stringify({
          level: 'error',
          event: 'log_persistence_failed',
          cause: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      throw new AppError(
        'LOG_PERSISTENCE_FAILED',
        '系统日志持久化失败；请求可能已执行，请勿自动重放',
        503,
      );
    }
    this.effects.stdout(JSON.stringify(record));
    for (const listener of this.listeners) listener(record);
    return record;
  }
  /** Detached runtime callbacks still persist metadata; drain reports failed writes on shutdown. */
  report(code: string, ownerId?: string) {
    const pending = this.write({ level: 'error', event: 'runtime_failure', code, ownerId });
    this.pending.add(pending);
    void pending
      .catch((error: unknown) => {
        this.failures.push(error);
      })
      .finally(() => this.pending.delete(pending));
  }
  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    if (this.failures.length)
      throw new AggregateError(this.failures.splice(0), '系统日志持久化失败');
  }
  subscribe(listener: (entry: LogEntry) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
export type DiagnosticLogger = Pick<SystemLogger, 'report'>;
export function databaseLogger(db: Database) {
  return new SystemLogger({
    persist: async (input) => (await db.insert(systemLogs).values(input).returning())[0]!,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
}
