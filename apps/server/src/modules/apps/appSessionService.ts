import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@platform/mcp';
import type { ConnectionService } from '../mcp/connectionService.js';
import type { ContentService } from '../mcp/contentService.js';
import type { ProfileService } from '../agent-profiles/profileService.js';
import type { InvocationService } from '../mcp/invocationService.js';
import {
  currentExecution,
  withExecution,
  PLATFORM_CAPABILITIES,
  type ExecutionContext,
} from '../mcp/executionContext.js';
import { scopedUri } from '../mcp/catalogEntries.js';
import { AppError } from '../../shared/errors.js';
type Session = {
  id: string;
  ownerId: string;
  connectionId: string;
  resourceUri: string;
  toolId: string;
  execution?: ExecutionContext;
  arguments: Record<string, unknown>;
  result: CallToolResult;
  signal: AbortSignal;
  abort: AbortController;
  release: () => void;
  permissionRelease?: () => void;
  context?: unknown;
  pendingMessage?: unknown;
  viewed?: boolean;
};
export class AppSessionService {
  private readonly sessions = new Map<string, Session>();
  constructor(
    private readonly deps: {
      connections: ConnectionService;
      content: ContentService;
      profiles: ProfileService;
      invoke: InvocationService['call'];
      sandboxOrigin: string;
      send: (ownerId: string, input: { profileId: string; prompt: string }) => Promise<unknown>;
    },
  ) {}
  async capture(input: {
    ownerId: string;
    connectionId: string;
    toolId: string;
    definition: Record<string, unknown>;
    arguments: Record<string, unknown>;
    result: CallToolResult;
  }) {
    if (currentExecution()?.entry === 'gateway' || currentExecution()?.appId) return input.result;
    const ui = (input.definition._meta as { ui?: { resourceUri?: string } } | undefined)?.ui;
    if (!ui?.resourceUri) return input.result;
    const id = randomUUID();
    const execution = currentExecution();
    const uri = scopedUri(input.connectionId, ui.resourceUri);
    await this.deps.content.resolveResource(
      { ownerId: input.ownerId, profileId: execution?.profileId },
      uri,
    );
    const lease = await this.deps.connections.lease(input.ownerId, input.connectionId);
    const abort = new AbortController();
    this.sessions.set(id, {
      ...input,
      id,
      resourceUri: uri,
      execution,
      abort,
      signal: AbortSignal.any([
        abort.signal,
        lease.signal,
        ...(execution?.signal ? [execution.signal] : []),
      ]),
      release: lease.release,
    });
    const permissionRelease = await this.deps.profiles.access?.monitor({
      access: { ownerId: input.ownerId, profileId: execution?.profileId },
      kind: 'contentIds',
      id: (
        await this.deps.content.resolveResource(
          { ownerId: input.ownerId, profileId: execution?.profileId },
          uri,
        )
      ).entry.id,
      cancel: () => this.close(input.ownerId, id),
    });
    const session = this.sessions.get(id);
    if (session) session.permissionRelease = permissionRelease;
    const signal = session?.signal ?? AbortSignal.abort();
    signal.addEventListener('abort', () => this.close(input.ownerId, id), { once: true });
    if (signal.aborted) this.close(input.ownerId, id);
    return { ...input.result, _meta: { ...input.result._meta, 'platform/appSession': id } };
  }
  list(ownerId: string, taskId?: string) {
    return [...this.sessions.values()]
      .filter((s) => s.ownerId === ownerId && (!taskId || s.execution?.taskId === taskId))
      .map((s) => ({ id: s.id, toolId: s.toolId, taskId: s.execution?.taskId }));
  }
  async view(ownerId: string, id: string) {
    return this.run(ownerId, id, async (session) => {
      if (session.viewed) {
        this.close(ownerId, id);
        throw new AppError('APP_VIEW_ENDED', 'App 视图已结束；刷新不会重放工具', 410);
      }
      session.viewed = true;
      const resource = await this.deps.content.read({
        ownerId,
        profileId: session.execution?.profileId,
        uri: session.resourceUri,
        signal: session.signal,
      });
      return {
        id,
        arguments: session.arguments,
        result: session.result,
        resource,
        sandboxOrigin: this.deps.sandboxOrigin,
      };
    });
  }
  async call(
    ownerId: string,
    id: string,
    input: { name: string; arguments?: Record<string, unknown>; signal?: AbortSignal },
  ) {
    return this.run(ownerId, id, async (session) => {
      const catalog = await this.deps.profiles.catalog(
        ownerId,
        session.execution?.profileId,
        session.connectionId,
      );
      const tool = catalog.find(
        (row) =>
          row.connectionId === session.connectionId &&
          (row.id === input.name || row.name === input.name),
      );
      const visibility = (tool?.definition._meta as { ui?: { visibility?: string[] } } | undefined)
        ?.ui?.visibility;
      if (!tool || (visibility && !visibility.includes('app')))
        throw new AppError('APP_TOOL_FORBIDDEN', 'App 工具不存在或未授权', 403);
      return this.deps.invoke({
        ownerId,
        profileId: session.execution?.profileId,
        toolId: tool.id,
        arguments: input.arguments ?? {},
        signal: input.signal ? AbortSignal.any([session.signal, input.signal]) : session.signal,
      });
    });
  }
  async resource(ownerId: string, id: string, uri: string) {
    return this.run(ownerId, id, async (s) => {
      const { entry } = await this.deps.content.resolveResource(
        { ownerId, profileId: s.execution?.profileId },
        uri,
      );
      if (entry.connectionId !== s.connectionId)
        throw new AppError('APP_RESOURCE_FORBIDDEN', 'App 不能访问其他连接的资源', 403);
      return this.deps.content.read({
        ownerId,
        profileId: s.execution?.profileId,
        uri,
        signal: s.signal,
      });
    });
  }
  async message(ownerId: string, id: string, input: { context?: unknown; message?: unknown }) {
    return this.run(ownerId, id, async (s) => {
      if (input.context !== undefined) s.context = input.context;
      if (input.message !== undefined) s.pendingMessage = input.message;
      return { queued: input.message !== undefined };
    });
  }
  async send(ownerId: string, id: string, text: string) {
    return this.run(ownerId, id, async (session) => {
      if (!session.execution?.profileId || !session.execution.taskId)
        throw new AppError('APP_MODEL_UNAVAILABLE', '工具测试页不提供模型会话', 409);
      const prompt = JSON.stringify({
        source: { app: session.resourceUri, taskId: session.execution.taskId },
        userMessage: text,
        appContext: session.context,
      });
      const task = await this.deps.send(ownerId, {
        profileId: session.execution.profileId,
        prompt,
      });
      session.pendingMessage = undefined;
      return task;
    });
  }
  private async run<T>(ownerId: string, id: string, action: (session: Session) => Promise<T>) {
    const session = this.sessions.get(id);
    if (!session || session.ownerId !== ownerId || session.signal.aborted)
      throw new AppError('APP_VIEW_ENDED', 'App 视图已结束；不会重放工具恢复视图', 410);
    const invoke = async () => {
      await this.deps.content.resolveResource(
        { ownerId, profileId: session.execution?.profileId },
        session.resourceUri,
      );
      return action(session);
    };
    return withExecution(
      {
        ...(session.execution ?? {
          identity: 'dashboard',
          entry: 'dashboard',
          sessionId: 'dashboard',
          capabilities: PLATFORM_CAPABILITIES,
        }),
        appId: id,
      },
      invoke,
    );
  }
  close(ownerId: string, id: string) {
    const session = this.sessions.get(id);
    if (!session || session.ownerId !== ownerId) return;
    this.sessions.delete(id);
    session.abort.abort(new Error('App 视图已结束'));
    session.release();
    session.permissionRelease?.();
  }
}
