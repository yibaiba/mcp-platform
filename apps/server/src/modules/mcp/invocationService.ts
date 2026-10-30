import type { PresentationService } from '../result-presentation/presentationService.js';
import type { RuntimeMetrics } from '../activity/runtimeMetrics.js';
import type { DiagnosticLogger } from '../activity/systemLogger.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { calls, type Database } from '@platform/db';
import { AppError } from '../../shared/errors.js';
import type { ProfileService, Principal } from '../agent-profiles/profileService.js';
import type { ConnectionService } from './connectionService.js';
import {
  parseTool,
  ExecutionBudget,
  validateToolValue,
  isInputRequiredResult,
  type McpToolResult,
  type Progress,
} from '@platform/mcp';
import type { InteractionService, PendingResult } from '../interactions/interactionService.js';
import { currentExecution, withExecution, PLATFORM_CAPABILITIES } from './executionContext.js';
import { assertVisibleArguments } from '../catalog/projection.js';
import { scopeResult } from './catalogEntries.js';
import type { RuntimeEvents } from '../../shared/runtimeEvents.js';
type CallInput = {
  callId?: string;
  ownerId: string;
  profileId?: string;
  principal?: Principal;
  toolId: string;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
  requestSignal?: AbortSignal;
  onprogress?: (progress: Progress) => void;
  requestState?: string;
  inputResponses?: Record<string, unknown>;
  interactionDeadline?: string;
};
type Active = {
  ownerId: string;
  profileId?: string;
  credentialId?: string;
  abort: AbortController;
};
export class InvocationService {
  private readonly active = new Map<string, Active>();
  constructor(
    private readonly deps: {
      db: Database;
      metrics: RuntimeMetrics;
      presentation: PresentationService;
      logger: DiagnosticLogger;
      profiles: ProfileService;
      connections: ConnectionService;
      interactions: InteractionService;
      events: RuntimeEvents;
      onResult: import('../apps/appSessionService.js').AppSessionService['capture'];
    },
  ) {}
  async call(input: CallInput): Promise<CallToolResult> {
    const result = await this.dispatch(input);
    return CallToolResultSchema.parse(
      isInputRequiredResult(result)
        ? await this.deps.interactions.wait(result as PendingResult)
        : result,
    );
  }
  dispatch(input: CallInput): Promise<McpToolResult> {
    const context = currentExecution();
    return withExecution(
      {
        ...(context ?? {
          identity: 'dashboard',
          entry: 'dashboard',
          sessionId: 'dashboard',
          capabilities: PLATFORM_CAPABILITIES,
        }),
        ownerId: input.ownerId,
        profileId: input.profileId ?? context?.profileId,
        correlationId: randomUUID(),
      },
      () => this.execute(input),
    );
  }
  private async execute(input: CallInput): Promise<McpToolResult> {
    const started = performance.now();
    if (input.principal)
      await this.deps.profiles.authenticate(input.principal.profileId, input.principal.token);
    const tool = await this.deps.profiles.tool(input.ownerId, input);
    if (!tool) throw new AppError('TOOL_FORBIDDEN', '该工具不存在或未授权', 403);
    assertVisibleArguments(tool, input.arguments);
    const connection = await this.deps.connections.accessible(input.ownerId, tool.connectionId);
    if (connection.status === 'stopped')
      throw new AppError('CONNECTION_STOPPED', '连接已停止，请先启动', 409);
    const id = input.callId ?? randomUUID();
    if ('unavailable' in tool && tool.unavailable)
      return this.unavailable(input, id, connection.id, tool.unavailable);
    const abort = new AbortController();
    const deadline = input.interactionDeadline ? Date.parse(input.interactionDeadline) : undefined;
    if (deadline !== undefined && (!Number.isFinite(deadline) || deadline <= Date.now()))
      throw new AppError('INTERACTION_DEADLINE', '交互截止时间无效或已过期');
    let deadlineTimer: NodeJS.Timeout | undefined;
    let releasePermission = () => {};
    const execution = currentExecution();
    const context = await this.deps.connections.context(input.ownerId, connection.id);
    const budget = new ExecutionBudget(context.config.requestOptions);
    const adapter = await this.deps.connections.adapter(input.ownerId, connection.id);
    const present = await this.deps.presentation.prepare({
      ownerId: input.ownerId,
      profileId: input.profileId,
      connectionId: connection.id,
      toolId: tool.id,
      callId: id,
      definition: tool.definition,
    });
    const lease = await this.deps.connections.lease(input.ownerId, connection.id);
    const signal = AbortSignal.any([
      abort.signal,
      lease.signal,
      ...(input.signal ? [input.signal] : []),
    ]);
    try {
      await this.deps.db.insert(calls).values({
        id,
        ownerId: input.ownerId,
        profileId: input.profileId,
        toolId: tool.id,
        connectionId: connection.id,
        adapter: context.config.adapter,
        deviceId: context.config.deviceId,
        status: 'running',
        taskId: execution?.taskId,
        credentialId: execution?.credentialId,
        bindingId: context.bindingId,
        shareId: context.shareId,
        shareVersion: context.shareVersion,
        resourceOwnerId: context.resourceOwnerId ?? input.ownerId,
        credentialOwnerId: context.credentialScope?.ownerId ?? input.ownerId,
        sessionId: context.sessionId,
        entry: execution?.entry ?? 'dashboard',
        correlationId: execution?.correlationId,
      });
    } catch (error) {
      lease.release();
      throw error;
    }
    this.deps.metrics.begin(id, {
      started,
      labels: { entry: execution?.entry ?? 'dashboard', adapter: context.config.adapter },
    });
    this.active.set(id, {
      ownerId: input.ownerId,
      profileId: input.profileId,
      credentialId: input.principal?.credentialId,
      abort,
    });
    const interrupted = () => {
      if (!this.active.has(id)) return;
      this.active.delete(id);
      lease.release();
      releasePermission();
      clearTimeout(deadlineTimer);
      budget.pause();
      void this.finish(id, 'unknown', '调用或运行会话已中断').catch(() =>
        this.deps.logger.report('CALL_INTERRUPTION_PERSISTENCE_FAILED', input.ownerId),
      );
    };
    signal.addEventListener('abort', interrupted, { once: true });
    const round = async (continuation?: {
      requestState?: string;
      inputResponses?: Record<string, unknown>;
    }): Promise<McpToolResult> => {
      let waiting = false;
      clearTimeout(deadlineTimer);
      try {
        if (!continuation) {
          releasePermission =
            (await this.deps.profiles.access?.monitor({
              access: input,
              kind: 'toolIds',
              id: tool.id,
              cancel: () => abort.abort(new Error('工具授权已失效')),
            })) ?? (() => {});
          this.deps.events.publish({
            ownerId: input.ownerId,
            kind: 'call',
            id,
            status: 'running',
            revision: 1,
          });
        }
        signal.throwIfAborted();
        if (input.principal)
          await this.deps.profiles.authenticate(input.principal.profileId, input.principal.token);
        const current = await this.deps.profiles.tool(input.ownerId, input);
        if (!current) throw new AppError('GRANT_REVOKED', '请求期间工具权限已撤销', 403);
        assertVisibleArguments(current, input.arguments);
        const definition = parseTool(current.definition);
        validateToolValue({ tool: definition, field: 'inputSchema', value: input.arguments });
        budget.resume();
        this.deps.metrics.resume(id);
        const network = AbortSignal.any([
          signal,
          budget.signal,
          ...(!continuation && input.requestSignal ? [input.requestSignal] : []),
        ]);
        // A completed HTTP response ends only the network round. Legacy elicitation
        // may still be waiting on the same upstream dispatch until the call ends.
        const networkAbort = new AbortController();
        const forwardAbort = () => networkAbort.abort(network.reason);
        network.addEventListener('abort', forwardAbort, { once: true });
        if (network.aborted) forwardAbort();
        const result = await adapter
          .call({
            name: tool.name,
            arguments: input.arguments,
            signal: AbortSignal.any([signal, networkAbort.signal]),
            executionTimeoutMs: budget.remainingMs,
            onprogress: (progress) => {
              budget.progress(progress);
              input.onprogress?.(progress);
            },
            ...continuation,
          })
          .finally(() => {
            budget.pause();
            this.deps.metrics.pause(id);
            network.removeEventListener('abort', forwardAbort);
          });
        signal.throwIfAborted();
        if (isInputRequiredResult(result)) {
          const required = await this.deps.interactions.create({
            ownerId: input.ownerId,
            connectionId: connection.id,
            bindingId: context.bindingId!,
            callId: id,
            toolId: input.toolId,
            credentialId: input.principal?.credentialId,
            required: result,
            signal,
            resume: (responses) => {
              const resume = () =>
                round({ requestState: result.requestState, inputResponses: responses });
              return execution ? withExecution(execution, resume) : resume();
            },
          });
          waiting = true;
          await this.finish(id, 'waiting');
          if (deadline !== undefined)
            deadlineTimer = setTimeout(
              () => abort.abort(new Error('交互等待截止时间已到')),
              Math.max(0, deadline - Date.now()),
            );
          return required;
        }
        if (!result.isError)
          validateToolValue({
            tool: definition,
            field: 'outputSchema',
            value: result.structuredContent,
          });
        const displayed = scopeResult(connection.id, await present(result));
        const captured =
          execution?.entry === 'rest'
            ? displayed
            : await this.deps.onResult({
                ownerId: input.ownerId,
                connectionId: connection.id,
                toolId: tool.id,
                definition: tool.definition,
                arguments: input.arguments,
                result: displayed,
              });
        await this.finish(id, result.isError ? 'tool_error' : 'succeeded');
        return captured;
      } catch (error) {
        const message =
          context.shareId && context.credentialScope?.ownerId !== input.ownerId
            ? '共享上游调用失败；请联系所有者检查授权或设备'
            : this.deps.connections.redact(error, context.config);
        const unknown =
          signal.aborted ||
          budget.signal.aborted ||
          (error instanceof AppError && error.code === 'RESULT_UNKNOWN');
        await this.finish(
          id,
          unknown ? 'unknown' : 'failed',
          unknown
            ? 'RESULT_UNKNOWN: 调用中断或超时；上游可能已执行，请先核实结果'
            : 'CALL_FAILED: 调用或协议校验失败；具体错误仅返回给本次调用方',
        );
        if (error instanceof AppError && error.code === 'RESULT_ORIGINAL_SAVE_FAILED') throw error;
        throw new AppError(unknown ? 'RESULT_UNKNOWN' : 'CALL_FAILED', message, 502);
      } finally {
        if (!waiting) {
          budget.pause();
          this.active.delete(id);
          lease.release();
          releasePermission();
          clearTimeout(deadlineTimer);
          signal.removeEventListener('abort', interrupted);
        }
      }
    };
    return round();
  }
  /**
   * The upstream or device is known to be down: record a failed call naming the connection and
   * the next step instead of letting the call disappear before it reaches the call log.
   */
  private async unavailable(
    input: CallInput,
    id: string,
    connectionId: string,
    reason: { code: string; message: string },
  ): Promise<never> {
    const execution = currentExecution();
    const context = await this.deps.connections.context(input.ownerId, connectionId);
    const error = `${reason.code}: ${reason.message}`;
    await this.deps.db.insert(calls).values({
      id,
      ownerId: input.ownerId,
      profileId: input.profileId,
      toolId: input.toolId,
      connectionId,
      adapter: context.config.adapter,
      deviceId: context.config.deviceId,
      status: 'failed',
      error,
      phase: 'dispatch',
      // Same clock as startedAt so the recorded duration is never negative.
      endedAt: sql`now()`,
      taskId: execution?.taskId,
      credentialId: execution?.credentialId,
      bindingId: context.bindingId,
      shareId: context.shareId,
      shareVersion: context.shareVersion,
      resourceOwnerId: context.resourceOwnerId ?? input.ownerId,
      credentialOwnerId: context.credentialScope?.ownerId ?? input.ownerId,
      sessionId: context.sessionId,
      entry: execution?.entry ?? 'dashboard',
      correlationId: execution?.correlationId,
    });
    this.deps.events.publish({
      ownerId: input.ownerId,
      kind: 'call',
      id,
      status: 'failed',
      error,
      revision: 1,
    });
    throw new AppError('CONNECTION_UNAVAILABLE', reason.message, 503);
  }
  private async finish(id: string, status: string, error?: string) {
    const [row] = await this.deps.db
      .update(calls)
      .set({
        status,
        error,
        phase: status === 'waiting' ? 'interaction' : 'upstream',
        revision: sql`${calls.revision} + 1`,
        endedAt: status === 'waiting' ? null : new Date(),
      })
      .where(and(eq(calls.id, id), inArray(calls.status, ['running', 'waiting'])))
      .returning({ ownerId: calls.ownerId, revision: calls.revision });
    if (row && status !== 'waiting')
      this.deps.metrics.finish(id, status as 'succeeded' | 'tool_error' | 'failed' | 'unknown');
    if (row)
      this.deps.events.publish({
        ownerId: row.ownerId,
        kind: 'call',
        id,
        status,
        error,
        revision: row.revision,
      });
  }
  cancel(ownerId: string, id: string) {
    const current = this.active.get(id);
    if (!current || current.ownerId !== ownerId)
      throw new AppError('CALL_NOT_RUNNING', '调用不在当前进程中运行', 404);
    this.deps.metrics.cancel(id);
    current.abort.abort();
    this.active.delete(id);
  }
  revoke(input: { ownerId?: string; profileId?: string; credentialId?: string }) {
    for (const current of this.active.values())
      if (
        (input.ownerId && current.ownerId === input.ownerId) ||
        (input.profileId && current.profileId === input.profileId) ||
        (input.credentialId && current.credentialId === input.credentialId)
      )
        current.abort.abort();
  }
}
