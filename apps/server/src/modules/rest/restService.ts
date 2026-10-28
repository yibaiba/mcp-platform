import type { ElicitResult } from '@modelcontextprotocol/client';
import { isInputRequiredResult, type McpToolResult } from '@platform/mcp';
import type { Principal, ProfileService } from '../agent-profiles/profileService.js';
import type { InvocationService } from '../mcp/invocationService.js';
import {
  validateResponses,
  type InteractionService,
  type PendingResult,
} from '../interactions/interactionService.js';
import { withExecution } from '../mcp/executionContext.js';
import { fingerprint } from '../configuration/values.js';
import { AppError } from '../../shared/errors.js';
import type { DiagnosticLogger } from '../activity/systemLogger.js';
import type { ResultStore } from './resultStore.js';
import type { RestCallStore, RestCall } from './callStore.js';
export const REST_CAPABILITIES = { elicitation: { form: {}, url: {} } };
export class RestService {
  private readonly controllers = new Map<string, { ownerId: string; abort: AbortController }>();
  private readonly active = new Map<string, { abort: AbortController; work: Promise<unknown> }>();
  constructor(
    private readonly deps: {
      profiles: ProfileService;
      invocations: InvocationService;
      interactions: InteractionService;
      store: RestCallStore;
      results: ResultStore;
      logger: DiagnosticLogger;
    },
  ) {}
  context<T>(principal: Principal, action: () => T, headers?: Readonly<Record<string, string>>) {
    return withExecution(
      {
        ownerId: principal.ownerId,
        profileId: principal.profileId,
        identity: principal.credentialId,
        credentialId: principal.credentialId,
        entry: 'rest',
        sessionId: principal.credentialId,
        capabilities: REST_CAPABILITIES,
        headers,
      },
      action,
    );
  }
  private async authorize(principal: Principal, toolId?: string) {
    await this.deps.profiles.authenticate(principal.profileId, principal.token);
    if (toolId) await this.deps.profiles.access!.assert(principal, 'toolIds', toolId);
  }
  async start(
    principal: Principal,
    input: { toolId: string; arguments: Record<string, unknown>; idempotencyKey?: string },
  ) {
    await this.authorize(principal, input.toolId);
    const reserved = await this.deps.store.reserve(principal, {
      toolId: input.toolId,
      requestHash: fingerprint({ toolId: input.toolId, arguments: input.arguments }),
      idempotencyKey: input.idempotencyKey,
    });
    if (reserved.created) {
      const abort = new AbortController();
      this.controllers.set(reserved.row.id, { ownerId: principal.ownerId, abort });
      await this.track(reserved.row.id, abort, () =>
        this.execute(reserved.row, () =>
          this.deps.invocations.dispatch({
            ...principal,
            principal,
            callId: reserved.row.id,
            toolId: input.toolId,
            arguments: input.arguments,
            signal: abort.signal,
          }),
        ),
      );
    }
    return this.response(principal, reserved.row.id);
  }
  private async track<T>(id: string, abort: AbortController, action: () => Promise<T>) {
    const work = Promise.resolve().then(action);
    this.active.set(id, { abort, work });
    try {
      return await work;
    } finally {
      this.active.delete(id);
    }
  }
  private async execute(row: RestCall, action: () => Promise<McpToolResult>) {
    let result: McpToolResult;
    try {
      result = await action();
    } catch (error) {
      this.controllers.delete(row.id);
      const unknown =
        error instanceof AppError &&
        ['RESULT_UNKNOWN', 'INTERACTION_INTERRUPTED'].includes(error.code);
      await this.deps.store.update(row.id, {
        status: unknown ? 'unknown' : 'failed',
        errorCode: unknown ? 'RESULT_UNKNOWN' : 'CALL_FAILED',
        endedAt: new Date(),
      });
      throw error;
    }
    if (isInputRequiredResult(result)) {
      await this.deps.store.update(row.id, {
        status: 'waiting',
        interactionId: (result as PendingResult).interactionId,
      });
      return;
    }
    this.controllers.delete(row.id);
    try {
      const resultDigest = await this.deps.results.save(row, result);
      await this.deps.store.update(row.id, {
        status: result.isError ? 'tool_error' : 'succeeded',
        resultDigest,
        interactionId: null,
        endedAt: new Date(),
      });
    } catch {
      await this.deps.store.update(row.id, {
        status: 'result_error',
        errorCode: 'REST_RESULT_SAVE_FAILED',
        endedAt: new Date(),
      });
      this.deps.logger.report('REST_RESULT_SAVE_FAILED', row.ownerId);
      throw new AppError(
        'REST_RESULT_SAVE_FAILED',
        '工具已返回，但结果持久化失败；不会重新执行工具，请检查数据卷和数据库',
        500,
      );
    }
  }
  private async row(principal: Principal, id: string) {
    const row = await this.deps.store.owned(principal, id);
    await this.authorize(principal, row.toolId);
    return this.deps.store.synchronize(row);
  }
  async status(principal: Principal, id: string) {
    const row = await this.row(principal, id);
    const path = `/mcp/${row.profileId}/rest/calls/${row.id}`;
    return {
      callId: row.id,
      toolId: row.toolId,
      status: row.status,
      errorCode: row.errorCode,
      createdAt: row.createdAt,
      endedAt: row.endedAt,
      ...(row.status === 'waiting' ? await this.deps.store.interaction(row) : {}),
      links: {
        status: path,
        result: `${path}/result`,
        answer: `${path}/answer`,
        cancel: `${path}/cancel`,
      },
    };
  }
  async result(principal: Principal, id: string) {
    const row = await this.row(principal, id);
    if (!['succeeded', 'tool_error'].includes(row.status) || !row.resultDigest)
      throw new AppError(
        'REST_RESULT_NOT_READY',
        `调用状态为 ${row.status}；尚无可读取结果，不会自动重放`,
        409,
      );
    const result = await this.deps.results.read(row, row.resultDigest);
    await this.authorize(principal, row.toolId);
    return result;
  }
  async response(principal: Principal, id: string) {
    const status = await this.status(principal, id);
    return {
      callId: id,
      status: ['succeeded', 'tool_error'].includes(status.status)
        ? (200 as const)
        : ['running', 'waiting'].includes(status.status)
          ? (202 as const)
          : status.status === 'result_error'
            ? (500 as const)
            : (409 as const),
      body: ['succeeded', 'tool_error'].includes(status.status)
        ? await this.result(principal, id)
        : status,
    };
  }
  async answer(
    principal: Principal,
    input: { id: string; interactionId: string; responses: Record<string, ElicitResult> },
  ) {
    const row = await this.row(principal, input.id);
    if (row.status !== 'waiting' || row.interactionId !== input.interactionId)
      throw new AppError('INTERACTION_DUPLICATE', '交互已提交、已结束或交互 ID 不匹配', 409);
    const interaction = await this.deps.store.interaction(row);
    validateResponses(interaction.inputRequests ?? {}, input.responses);
    await this.deps.store.claimAnswer(row, input.interactionId);
    await this.track(row.id, new AbortController(), () =>
      this.execute(
        row,
        () =>
          this.deps.interactions.respond({
            ownerId: principal.ownerId,
            credentialId: principal.credentialId,
            toolId: row.toolId,
            id: input.interactionId,
            responses: input.responses,
          }) as Promise<McpToolResult>,
      ),
    );
    return this.response(principal, row.id);
  }
  async cancel(principal: Principal, id: string) {
    const row = await this.row(principal, id);
    if (!['running', 'waiting'].includes(row.status))
      throw new AppError('CALL_NOT_RUNNING', '调用已结束', 409);
    try {
      this.deps.invocations.cancel(principal.ownerId, id);
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'CALL_NOT_RUNNING' && this.active.has(id)))
        throw error;
    }
    this.active.get(id)?.abort.abort(new Error('REST 调用已取消'));
    await this.deps.store.update(id, {
      status: 'unknown',
      errorCode: 'CANCELLED_RESULT_UNKNOWN',
      endedAt: new Date(),
    });
    return this.status(principal, id);
  }
  recover() {
    return this.deps.store.recover();
  }
  async close() {
    for (const [id, live] of this.controllers) {
      live.abort.abort(new Error('平台关闭'));
      try {
        this.deps.invocations.cancel(live.ownerId, id);
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'CALL_NOT_RUNNING')) throw error;
      }
    }
    this.controllers.clear();
    await Promise.allSettled([...this.active.values()].map((live) => live.work));
  }
}
