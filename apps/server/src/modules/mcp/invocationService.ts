import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CALL_TIMEOUT_MS } from '@platform/contracts';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { calls, type Database } from '@platform/db';
import { AppError } from '../../shared/errors.js';
import type { ProfileService, Principal } from '../agent-profiles/profileService.js';
import type { ConnectionService } from './connectionService.js';
import {
  parseTool,
  validateToolValue,
  isInputRequiredResult,
  type McpToolResult,
  type Progress,
} from '@platform/mcp';
import type { InteractionService, PendingResult } from '../interactions/interactionService.js';
import { currentExecution, withExecution, PLATFORM_CAPABILITIES } from './executionContext.js';
import { scopeResult } from './catalogEntries.js';
import type { RuntimeEvents } from '../../shared/runtimeEvents.js';
type CallInput = {
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
    if (input.principal)
      await this.deps.profiles.authenticate(input.principal.profileId, input.principal.token);
    const tool = await this.deps.profiles.tool(input.ownerId, input);
    if (!tool) throw new AppError('TOOL_FORBIDDEN', '该工具不存在或未授权', 403);
    const connection = await this.deps.connections.owned(input.ownerId, tool.connectionId);
    if (connection.status === 'stopped')
      throw new AppError('CONNECTION_STOPPED', '连接已停止，请先启动', 409);
    const id = randomUUID();
    const abort = new AbortController();
    const deadline = input.interactionDeadline ? Date.parse(input.interactionDeadline) : undefined;
    if (deadline !== undefined && (!Number.isFinite(deadline) || deadline <= Date.now()))
      throw new AppError('INTERACTION_DEADLINE', '交互截止时间无效或已过期');
    let deadlineTimer: NodeJS.Timeout | undefined;
    let releasePermission = () => {};
    const execution = currentExecution();
    const context = await this.deps.connections.context(input.ownerId, connection.id);
    const adapter = await this.deps.connections.adapter(input.ownerId, connection.id);
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
        adapter: connection.adapter,
        deviceId: connection.deviceId,
        status: 'running',
        taskId: execution?.taskId,
        credentialId: execution?.credentialId,
        bindingId: context.bindingId,
        sessionId: context.sessionId,
        entry: execution?.entry ?? 'dashboard',
        correlationId: execution?.correlationId,
      });
    } catch (error) {
      lease.release();
      throw error;
    }
    this.active.set(id, {
      ownerId: input.ownerId,
      profileId: input.profileId,
      credentialId: input.principal?.credentialId,
      abort,
    });
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
    const interrupted = () => {
      if (!this.active.has(id)) return;
      this.active.delete(id);
      lease.release();
      releasePermission();
      clearTimeout(deadlineTimer);
      void this.finish(id, 'unknown', '调用或运行会话已中断').catch((error: unknown) =>
        console.error('Call interruption persistence failed', error),
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
        signal.throwIfAborted();
        if (input.principal)
          await this.deps.profiles.authenticate(input.principal.profileId, input.principal.token);
        const current = await this.deps.profiles.tool(input.ownerId, input);
        if (!current) throw new AppError('GRANT_REVOKED', '请求期间工具权限已撤销', 403);
        const definition = parseTool(current.definition);
        validateToolValue({ tool: definition, field: 'inputSchema', value: input.arguments });
        const timeout = new AbortController();
        const timer = setTimeout(
          () => timeout.abort(new Error('MCP 网络执行超时')),
          CALL_TIMEOUT_MS,
        );
        const network = AbortSignal.any([
          signal,
          timeout.signal,
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
            onprogress: input.onprogress,
            ...continuation,
          })
          .finally(() => {
            clearTimeout(timer);
            network.removeEventListener('abort', forwardAbort);
          });
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
        await this.finish(id, result.isError ? 'tool_error' : 'succeeded');
        return this.deps.onResult({
          ownerId: input.ownerId,
          connectionId: connection.id,
          toolId: tool.id,
          definition: tool.definition,
          arguments: input.arguments,
          result: scopeResult(connection.id, result),
        });
      } catch (error) {
        const message = this.deps.connections.redact(error, context.config);
        const unknown =
          signal.aborted || (error instanceof AppError && error.code === 'RESULT_UNKNOWN');
        await this.finish(id, unknown ? 'unknown' : 'failed', message);
        throw new AppError(unknown ? 'RESULT_UNKNOWN' : 'CALL_FAILED', message, 502);
      } finally {
        if (!waiting) {
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
      .where(eq(calls.id, id))
      .returning({ ownerId: calls.ownerId, revision: calls.revision });
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
    current.abort.abort();
    this.active.delete(id);
  }
  revoke(input: { profileId?: string; credentialId?: string }) {
    for (const current of this.active.values())
      if (
        (input.profileId && current.profileId === input.profileId) ||
        (input.credentialId && current.credentialId === input.credentialId)
      )
        current.abort.abort();
  }
}
