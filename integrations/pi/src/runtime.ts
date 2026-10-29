import type { NetworkConfig } from '@platform/network';
import { fork } from 'node:child_process';
import { authorizationCoordinator } from './authorizationCoordinator.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  ModelRuntime,
  loadSkillsFromDir,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import type { McpNotification, McpOperation, McpRequestOptions, Progress } from '@platform/mcp';
import { isInputRequiredResult } from '@platform/mcp';
type Tool = { name: string; description?: string; inputSchema: Record<string, unknown> };
type Result = { content: { type: string; [key: string]: unknown }[]; [key: string]: unknown };
export type Context = {
  network?: NetworkConfig;
  oauthRedirectUri?: string;
  id: string;
  ownerId: string;
  bindingId?: string;
  credentialScope?: { ownerId: string; bindingId: string };
  runtimeKey?: string;
  capabilities?: Record<string, unknown>;
  config: {
    connectTimeoutMs?: number;
    requestOptions?: { timeoutMs: number };
    health?: { timeoutMs: number };
    transport?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers: Record<string, string>;
    oauth?: {
      clientId?: string;
      clientSecret?: string;
      scope?: string;
      clientMetadataUrl?: string;
      tokenEndpointAuthMethod?: 'none' | 'client_secret_post' | 'client_secret_basic';
    };
    lifecycle?: { shutdownGraceMs: number };
  };
};
export async function bridge(options: {
  context: Context;
  directory: string;
  authorizationKey?: string;
  diagnostic?: (code: string) => void;
}) {
  const bridgeContext = options.context;
  const diagnostic = options.diagnostic ?? ((code: string) => console.error(code));
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const worker = fork(new URL('./worker.ts', import.meta.url), [], {
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: options.directory,
      PI_MCP_ADAPTER_OAUTH_FILE_KEY:
        options.authorizationKey ?? process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY,
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  worker.stderr?.on('data', () => diagnostic('PI_WORKER_STDERR'));
  let connected = false;
  const lifetime = new AbortController();
  const authLeases = new Map<string, () => void>();
  const interactions = new Map<string, () => void>();
  const listeners = new Set<(notification: McpNotification) => void>();
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      onprogress?: (progress: Progress) => void;
    }
  >();
  worker.on(
    'message',
    (message: {
      id: string;
      type?: string;
      result?: unknown;
      error?: string;
      errorName?: string;
      errorCode?: string;
      notification?: McpNotification;
      progress?: Progress;
      code?: string;
    }) => {
      if (message.type === 'diagnostic') {
        diagnostic(
          message.code === 'PI_DISCONNECT_CLEANUP_FAILED' ? message.code : 'PI_IPC_DELIVERY_FAILED',
        );
        return;
      }
      if (message.type === 'auth-acquire') {
        void authorizationCoordinator.acquire(options.directory, lifetime.signal).then(
          (lease) => {
            if (!worker.connected) {
              lease.release();
              return;
            }
            authLeases.set(message.id, lease.release);
            worker.send({ type: 'auth-granted', id: message.id });
          },
          (error) => {
            if (worker.connected)
              worker.send({ type: 'auth-granted', id: message.id, error: String(error) });
          },
        );
        return;
      }
      if (message.type === 'auth-release') {
        authLeases.get(message.id)?.();
        authLeases.delete(message.id);
        return;
      }
      if (message.type === 'notification' && message.notification) {
        for (const listener of listeners) listener(message.notification);
        return;
      }
      if (message.type === 'progress' && message.progress) {
        pending.get(message.id)?.onprogress?.(message.progress);
        return;
      }
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if (message.error)
        call.reject(
          Object.assign(new Error(message.error), {
            name: message.errorName ?? 'Error',
            code: message.errorCode,
          }),
        );
      else call.resolve(message.result);
    },
  );
  worker.on('error', (error) => {
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  });
  worker.on('exit', (code) => {
    lifetime.abort(new Error('Pi worker exited'));
    for (const release of authLeases.values()) release();
    authLeases.clear();
    connected = false;
    for (const call of pending.values())
      call.reject(new Error(`Pi bridge exited (${code}); in-flight result unknown`));
    pending.clear();
  });
  function request(method: string, params: unknown, options: McpRequestOptions = {}) {
    const inputSignal = options.signal;
    const deadline =
      options.executionTimeoutMs === undefined
        ? AbortSignal.timeout(bridgeContext.config.connectTimeoutMs ?? 60_000)
        : undefined;
    const signal = AbortSignal.any([
      lifetime.signal,
      ...(inputSignal ? [inputSignal] : []),
      ...(deadline ? [deadline] : []),
    ]);
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Pi call cancelled before dispatch'));
        return;
      }
      const abort = () => {
        if (worker.connected) worker.send({ type: 'cancel', id });
        pending.delete(id);
        cleanup();
        reject(new Error('Pi call interrupted; execution result unknown'));
      };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      pending.set(id, {
        onprogress: options.onprogress,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      signal?.addEventListener('abort', abort, { once: true });
      worker.send({ type: 'request', id, method, params }, (error) => {
        if (error) {
          pending.delete(id);
          cleanup();
          reject(error);
        }
      });
    });
  }
  try {
    await request('initialize', options.context);
  } catch (error) {
    worker.kill();
    throw error;
  }
  return {
    status: () => (connected ? ('connected' as const) : ('disconnected' as const)),
    discover: async (signal?: AbortSignal) => {
      const tools = await request('discover', {}, { signal });
      connected = true;
      return tools;
    },
    catalog: async (signal?: AbortSignal) => {
      const catalog = await request('catalog', {}, { signal });
      connected = true;
      return catalog;
    },
    watch: (listener: (notification: McpNotification) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    request: (operation: McpOperation, options: McpRequestOptions = {}) =>
      request(
        'request',
        {
          operation,
          progress: !!options.onprogress,
          executionTimeoutMs: options.executionTimeoutMs,
        },
        options,
      ),
    call: async (
      input: { name: string; arguments: Record<string, unknown> } & McpRequestOptions,
    ) => {
      if (input.requestState) {
        interactions.get(input.requestState)?.();
        interactions.delete(input.requestState);
      }
      const result = await request(
        'call',
        {
          name: input.name,
          arguments: input.arguments,
          progress: !!input.onprogress,
          requestState: input.requestState,
          inputResponses: input.inputResponses,
        },
        input,
      );
      if (isInputRequiredResult(result) && result.requestState && input.signal) {
        const state = result.requestState;
        const signal = input.signal;
        const cancel = () => {
          interactions.delete(state);
          void request('interaction.cancel', { requestState: state }).catch(() =>
            diagnostic('PI_INTERACTION_CANCEL_FAILED'),
          );
        };
        interactions.set(state, () => signal.removeEventListener('abort', cancel));
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      }
      return result;
    },
    check: async (signal?: AbortSignal) => {
      await request(
        'check',
        {},
        { signal, executionTimeoutMs: bridgeContext.config.health?.timeoutMs },
      );
    },
    action: (input: Record<string, unknown>) => request('action', input),
    close: async () => {
      connected = false;
      for (const removeListener of interactions.values()) removeListener();
      interactions.clear();
      listeners.clear();
      if (!worker.connected) return;
      try {
        await request('close', {});
      } finally {
        worker.disconnect();
        worker.kill();
      }
    },
  };
}
type RunOptions = {
  directory: string;
  provider: string;
  model: string;
  prompt: string;
  instructions?: string;
  tools: Tool[];
  skills: { name: string; files: Record<string, string> }[];
  call: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<Result>;
  signal: AbortSignal;
  onText: (text: string) => void;
  activeTools?: () => Promise<string[]>;
};
export async function run(options: RunOptions) {
  const skillDirectory = join(options.directory, 'skills');
  await mkdir(skillDirectory, { recursive: true, mode: 0o700 });
  for (const skill of options.skills)
    for (const [relative, encoded] of Object.entries(skill.files)) {
      const target = join(skillDirectory, skill.name, relative);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, Buffer.from(encoded, 'base64'), { mode: 0o600 });
    }
  const modelRuntime = await ModelRuntime.create({
    authPath: join(options.directory, 'auth.json'),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const model = modelRuntime.getModel(options.provider, options.model);
  if (!model) throw new Error(`Unknown model: ${options.provider}/${options.model}`);
  const settings = SettingsManager.inMemory({ retry: { enabled: false } });
  const skills = loadSkillsFromDir({ dir: skillDirectory, source: 'platform' });
  if (skills.diagnostics.length)
    throw new Error(skills.diagnostics.map((d) => d.message).join('; '));
  const loader = new DefaultResourceLoader({
    cwd: options.directory,
    agentDir: options.directory,
    settingsManager: settings,
    noExtensions: true,
    disabledBuiltinExtensions: ['mcp'],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    skillsOverride: () => skills,
    appendSystemPrompt: [
      options.instructions ?? '',
      ...options.skills.map(
        (skill) =>
          `Skill ${skill.name}:\n${Buffer.from(skill.files['SKILL.md']!, 'base64').toString()}`,
      ),
    ].filter(Boolean),
  });
  await loader.reload();
  const customTools: ToolDefinition[] = options.tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description ?? tool.name,
    parameters: tool.inputSchema as TSchema,
    async execute(_id, args, signal) {
      const result = await options.call(tool.name, args as Record<string, unknown>, signal);
      if (options.activeTools) session.setActiveToolsByName(await options.activeTools());
      return {
        content: result.content.map((block) => ({
          type: 'text' as const,
          text: block.type === 'text' ? String(block.text) : JSON.stringify(block),
        })),
        details: { mcpResult: result },
      };
    },
  }));
  // The loader registers real Skills; source content is supplied without granting host filesystem tools.
  const { session } = await createAgentSession({
    cwd: options.directory,
    agentDir: options.directory,
    modelRuntime,
    model,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(),
    noTools: 'builtin',
    tools: customTools.map((t) => t.name),
    customTools,
  });
  const abort = () => {
    void session.abort();
  };
  options.signal.addEventListener('abort', abort, { once: true });
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
      options.onText(event.assistantMessageEvent.delta);
  });
  try {
    options.signal.throwIfAborted();
    if (options.activeTools) session.setActiveToolsByName(await options.activeTools());
    await session.prompt(options.prompt);
    const last = session.messages.at(-1);
    if (last?.role === 'assistant' && last.stopReason === 'error')
      throw new Error(last.errorMessage ?? 'Model execution failed');
    return session.getLastAssistantText() ?? '';
  } finally {
    unsubscribe();
    options.signal.removeEventListener('abort', abort);
    session.dispose();
  }
}
