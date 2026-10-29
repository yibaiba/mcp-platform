import type { NetworkService } from '../network/service.js';
import type { DiagnosticLogger } from '../activity/systemLogger.js';
import { assertCredentialManager } from '../authorizations/credentialScope.js';
import { TaskStore } from './taskStore.js';
import { OutputCheckpoint } from './outputCheckpoint.js';
import { artifactToolset } from '../artifacts/artifactTools.js';
import type { ArtifactService } from '../artifacts/artifactService.js';
import type { RequestService } from '../permissions/requestService.js';
import { availablePermissionTools } from '../permissions/tools.js';
import { withExecution } from '../mcp/executionContext.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { eq, inArray, desc } from 'drizzle-orm';
import { tasks, type Database } from '@platform/db';
import { type Config } from '../../config.js';
import { AppError, requireValue, errorMessage } from '../../shared/errors.js';
import type { ConnectionContext } from '../mcp/adapter.js';
import { PiBridges, type PiRuntime } from './piBridges.js';
export type { PiBridge, PiRuntime } from './piBridges.js';
import type { ProfileService } from '../agent-profiles/profileService.js';
import type { InvocationService } from '../mcp/invocationService.js';
import type { SkillService } from '../skills/skillService.js';
import type { ContentService } from '../mcp/contentService.js';
import { contentToolset } from './contentTools.js';
import type { RuntimeEvents } from '../../shared/runtimeEvents.js';
export class PiService {
  requests!: RequestService;
  get store() {
    return new TaskStore(this.deps);
  }
  private runtime?: Promise<PiRuntime>;
  private readonly bridges: PiBridges;
  private readonly running = new Map<
    string,
    { ownerId: string; profileId: string; abort: AbortController; done: Promise<void> }
  >();
  constructor(
    private readonly deps: {
      network: NetworkService;
      db: Database;
      logger: DiagnosticLogger;
      config: Config;
      profiles: ProfileService;
      invocations: InvocationService;
      skills: SkillService;
      content: ContentService;
      artifacts: ArtifactService;
      events: RuntimeEvents;
    },
  ) {
    this.bridges = new PiBridges({
      config: deps.config,
      load: () => this.load(),
      network: deps.network,
      logger: deps.logger,
    });
  }
  private load() {
    this.runtime ??= import('@platform/pi-runtime');
    return this.runtime;
  }
  bridge(context: ConnectionContext) {
    return this.bridges.bridge(context);
  }
  async action(context: ConnectionContext, input: Record<string, unknown>) {
    assertCredentialManager(context);
    return (await this.bridge(context)).action(input);
  }
  list(ownerId: string) {
    return this.deps.db
      .select()
      .from(tasks)
      .where(eq(tasks.ownerId, ownerId))
      .orderBy(desc(tasks.createdAt));
  }
  async start(ownerId: string, input: { profileId: string; prompt: string }, reservedId?: string) {
    if (this.deps.config.PI_ENABLED !== 'true')
      throw new AppError(
        'PI_DISABLED',
        '内置 Agent 任务未启用；请启用 PI_ENABLED 并配置模型供应商、模型 ID 和凭证；MCP 连接和 Pi 桥接可正常使用',
        409,
      );
    if (!this.deps.config.PI_MODEL_PROVIDER || !this.deps.config.PI_MODEL_ID)
      throw new AppError(
        'MODEL_REQUIRED',
        '执行内置 Agent 任务需要配置 PI_MODEL_PROVIDER、PI_MODEL_ID 和模型供应商凭证；MCP 连接无需模型',
      );
    await this.deps.profiles.owned(ownerId, input.profileId);
    await this.load();
    const id = reservedId ?? randomUUID();
    const abort = new AbortController();
    if (!reservedId)
      await this.deps.db.insert(tasks).values({ id, ownerId, ...input, status: 'running' });
    else await this.store.update(id, { status: 'running' });
    this.deps.events.publish({ ownerId, kind: 'task', id, status: 'running' });
    const done = withExecution(
      {
        identity: `pi:${input.profileId}`,
        ownerId,
        signal: abort.signal,
        profileId: input.profileId,
        taskId: id,
        entry: 'pi',
        sessionId: id,
        capabilities: {
          elicitation: { form: {}, url: {} },
          extensions: {
            'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
          },
        },
      },
      () => this.run(id, ownerId, { ...input, abort }),
    );
    this.running.set(id, { ownerId, profileId: input.profileId, abort, done });
    void done
      .finally(() => this.running.delete(id))
      .catch(() => this.deps.logger.report('TASK_PERSISTENCE_FAILED', ownerId));
    return { id };
  }
  private async run(
    id: string,
    ownerId: string,
    input: { profileId: string; prompt: string; abort: AbortController },
  ) {
    let output = '';
    let persistenceFailure = false;
    const checkpoint = new OutputCheckpoint({
      write: (text) => this.store.update(id, { output: text }),
      failed: (error) => {
        persistenceFailure = true;
        this.deps.logger.report('TASK_CHECKPOINT_FAILED', ownerId);
        input.abort.abort(error);
      },
    });
    try {
      const profile = await this.deps.profiles.owned(ownerId, input.profileId);
      const catalog = await this.deps.profiles.discovery.exposed(ownerId, input.profileId, true);
      const permissionTools = await availablePermissionTools(this.requests, {
        ownerId,
        profileId: input.profileId,
      });
      const content = await contentToolset(this.deps.content, {
        ownerId,
        profileId: input.profileId,
      });
      const artifacts = await artifactToolset(
        {
          artifacts: this.deps.artifacts,
          profiles: this.deps.profiles,
          access: this.deps.profiles.access!,
        },
        { ownerId, profileId: input.profileId },
      );
      const skills = await Promise.all(
        profile.skillVersionIds.map((version) => this.deps.skills.version(ownerId, version)),
      );
      const runtime = await this.load();
      output = await runtime.run({
        directory: resolve(this.deps.config.DATA_DIR, 'pi', ownerId, 'tasks', id),
        provider: this.deps.config.PI_MODEL_PROVIDER!,
        model: this.deps.config.PI_MODEL_ID!,
        prompt: input.prompt,
        instructions: await this.deps.profiles.instructions(ownerId, input.profileId),
        tools: [
          ...permissionTools,
          ...content.tools,
          ...artifacts.tools,
          ...catalog.filter((definition) => modelVisible({ definition })),
        ],
        skills,
        signal: input.abort.signal,
        activeTools: async () => [
          ...permissionTools.map((t) => t.name),
          ...content.tools.map((t) => t.name),
          ...artifacts.tools.map((t) => t.name),
          ...(await this.deps.profiles.discovery.exposed(ownerId, input.profileId))
            .filter((definition) => modelVisible({ definition }))
            .map((tool) => tool.name),
        ],
        call: async (name, args, signal) => {
          const access = { ownerId, profileId: input.profileId };
          if (name === 'platform_permissions_catalog')
            return textResult(await this.requests.catalog(access));
          if (name === 'platform_permissions_status')
            return textResult(await this.requests.status(access, String(args.id)));
          if (name === 'platform_permissions_request') {
            const request = await this.requests.create(access, args);
            await checkpoint.flush();
            await this.store.update(id, { status: 'waiting_authorization' });
            const result = await this.requests.wait(access, request.id, input.abort.signal);
            await this.store.update(id, { status: 'running' });
            return textResult({
              status: result.status,
              approved: result.approved,
              expiresAt: result.expiresAt,
              next: '授权审批不执行业务，请发起新的工具调用',
            });
          }
          const discovered = await this.deps.profiles.discovery.read(ownerId, {
            profileId: input.profileId,
            name,
            arguments: args,
          });
          if (discovered !== undefined) return textResult(discovered);
          if (content.handles(name)) return content.call(name, args, signal);
          if (artifacts.handles(name)) return artifacts.call(name, args, signal);
          const invocation = await this.deps.profiles.discovery.resolveCall(ownerId, {
            profileId: input.profileId,
            name,
            arguments: args,
          });
          return this.deps.invocations.call({ ...access, ...invocation, signal });
        },
        onText: (text) => {
          output += text;
          checkpoint.append(output);
        },
      });
      await checkpoint.flush();
      await this.store.update(id, {
        status: input.abort.signal.aborted ? 'cancelled' : 'succeeded',
        output,
        endedAt: new Date(),
      });
    } catch (error) {
      let failure = error;
      try {
        await checkpoint.flush();
      } catch (checkpointError) {
        failure = checkpointError;
      }
      await this.store.update(id, {
        status: input.abort.signal.aborted && !persistenceFailure ? 'cancelled' : 'failed',
        output,
        error: errorMessage(failure),
        endedAt: new Date(),
      });
    } finally {
      await this.deps.profiles.access?.changed();
      await this.requests.reconcile(input.profileId);
    }
  }

  async cancel(ownerId: string, id: string) {
    const task = requireValue(this.running.get(id), '任务未在当前进程运行');
    if (task.ownerId !== ownerId) throw new AppError('NOT_FOUND', '任务不存在', 404);
    task.abort.abort();
    await task.done;
  }
  async revokeProfile(profileId: string) {
    for (const task of this.running.values()) if (task.profileId === profileId) task.abort.abort();
  }
  async revokeOwner(ownerId: string) {
    const tasks = [...this.running.values()].filter((task) => task.ownerId === ownerId);
    for (const task of tasks) task.abort.abort();
    await Promise.all(tasks.map((task) => task.done));
  }
  async close() {
    for (const task of this.running.values()) task.abort.abort();
    await Promise.all([...this.running.values()].map((task) => task.done));
    await this.bridges.close();
  }
  async recover() {
    const interrupted = await this.deps.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.status, ['running', 'waiting_authorization', 'queued']));
    for (const row of interrupted)
      await this.store.update(row.id, {
        status: 'unknown',
        endedAt: new Date(),
        error: '平台重启中断任务；请检查工具调用记录，不会自动重放',
      });
  }
}

const textResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});
const modelVisible = (t: { definition: Record<string, unknown> }) => {
  const ui = (t.definition._meta as { ui?: { visibility?: string[] } } | undefined)?.ui;
  return !ui?.visibility || ui.visibility.includes('model');
};
