import type { DiagnosticLogger } from '../activity/systemLogger.js';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { interactions, type Database } from '@platform/db';
import {
  isInputRequiredResult,
  type InputRequiredResult,
  type ElicitResult,
  type ElicitRequestParams,
} from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { Vault } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
const validator = new AjvJsonSchemaValidator();
export type PendingResult = InputRequiredResult & { interactionId: string; callId: string };
type Live = {
  ownerId: string;
  credentialId?: string;
  toolId: string;
  requests: NonNullable<InputRequiredResult['inputRequests']>;
  resume: (responses: Record<string, ElicitResult>) => Promise<unknown>;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  result: Promise<unknown>;
  submitted: boolean;
};
export class InteractionService {
  private readonly pending = new Map<string, Live>();
  constructor(private readonly deps: { db: Database; vault: Vault; logger: DiagnosticLogger }) {}
  async create(input: {
    ownerId: string;
    connectionId: string;
    bindingId: string;
    callId: string;
    toolId: string;
    credentialId?: string;
    required: InputRequiredResult;
    resume: Live['resume'];
    signal: AbortSignal;
  }) {
    const id = randomUUID();
    let resolve!: Live['resolve'];
    let reject!: Live['reject'];
    const result = new Promise((a, b) => {
      resolve = a;
      reject = b;
    });
    // A response can be collected through HTTP without a local waiter; keep rejection observable to waiters.
    void result.catch(() => {});
    const entry: Live = {
      ...input,
      requests: input.required.inputRequests ?? {},
      result,
      resolve,
      reject,
      submitted: false,
    };
    const abort = () => {
      this.pending.delete(id);
      reject(new AppError('INTERACTION_INTERRUPTED', '原调用已中断，不能续传', 409));
      void this.finish(id, 'interrupted').catch(() =>
        this.deps.logger.report('INTERACTION_PERSISTENCE_FAILED', input.ownerId),
      );
    };
    await this.deps.db.insert(interactions).values({
      id,
      ownerId: input.ownerId,
      connectionId: input.connectionId,
      bindingId: input.bindingId,
      callId: input.callId,
      encrypted: this.deps.vault.seal(input.required, `interaction:${input.ownerId}:${id}`),
    });
    this.pending.set(id, entry);
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    void result.finally(() => input.signal.removeEventListener('abort', abort)).catch(() => {});
    return {
      ...input.required,
      requestState: id,
      interactionId: id,
      callId: input.callId,
    } satisfies PendingResult;
  }
  async list(ownerId: string) {
    const rows = await this.deps.db
      .select()
      .from(interactions)
      .where(and(eq(interactions.ownerId, ownerId), eq(interactions.status, 'waiting')));
    return rows.map(({ encrypted, ...row }) => ({
      ...row,
      request: this.deps.vault.open(encrypted, `interaction:${ownerId}:${row.id}`),
      active: this.pending.has(row.id),
      managedExternally: Boolean(this.pending.get(row.id)?.credentialId),
    }));
  }
  async respond(input: {
    ownerId: string;
    id: string;
    credentialId?: string;
    toolId?: string;
    responses: Record<string, ElicitResult>;
  }) {
    const pending = this.pending.get(input.id);
    if (
      !pending ||
      pending.ownerId !== input.ownerId ||
      pending.credentialId !== input.credentialId ||
      (input.toolId && pending.toolId !== input.toolId)
    )
      throw new AppError('INTERACTION_INTERRUPTED', '交互已结束、调用不匹配或不属于当前身份', 409);
    if (pending.submitted) throw new AppError('INTERACTION_DUPLICATE', '交互响应已提交', 409);
    validateResponses(pending.requests, input.responses);
    pending.submitted = true;
    try {
      const result = await pending.resume(input.responses);
      await this.finish(input.id, 'completed');
      pending.resolve(result);
      return result;
    } catch (error) {
      await this.finish(input.id, 'failed');
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this.pending.delete(input.id);
    }
  }
  async wait(result: PendingResult): Promise<unknown> {
    const pending = this.pending.get(result.interactionId);
    if (!pending) throw new AppError('INTERACTION_INTERRUPTED', '交互已中断', 409);
    const next = await pending.result;
    return isInputRequiredResult(next) && 'interactionId' in next
      ? this.wait(next as PendingResult)
      : next;
  }
  private finish(id: string, status: string) {
    return this.deps.db.update(interactions).set({ status }).where(eq(interactions.id, id));
  }
  async recover() {
    await this.deps.db
      .update(interactions)
      .set({ status: 'interrupted' })
      .where(eq(interactions.status, 'waiting'));
  }
}
export function validateResponses(
  requests: NonNullable<InputRequiredResult['inputRequests']>,
  responses: Record<string, ElicitResult>,
) {
  if (Object.keys(requests).length !== Object.keys(responses).length)
    throw new AppError('ELICITATION_RESPONSES', '请逐项响应所有交互请求');
  for (const [id, request] of Object.entries(requests)) {
    if (request.method !== 'elicitation/create')
      throw new AppError('INTERACTION_METHOD', `不支持交互方法 ${request.method}`);
    const response = responses[id];
    if (!response || !['accept', 'decline', 'cancel'].includes(response.action))
      throw new AppError('ELICITATION_ACTION', '交互响应无效');
    const params = request.params as ElicitRequestParams;
    if (response.action !== 'accept' || params.mode === 'url') continue;
    if (params.requestedSchema) {
      const result = validator.getValidator(params.requestedSchema)(response.content);
      if (!result.valid)
        throw new AppError('ELICITATION_SCHEMA', result.errorMessage ?? '交互表单校验失败');
    }
  }
}
