import {
  Client,
  StreamableHTTPClientTransport,
  SSEClientTransport,
  ManagedStdioTransport,
  discoverCatalog,
  executeOperation,
  InteractiveClient,
  observeNotifications,
  McpValidationError,
  type McpNotification,
  type McpCatalog,
} from '@platform/mcp';
import { isInputRequiredResult } from '@platform/mcp';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { AppError, errorMessage } from '../../shared/errors.js';
import { CALL_TIMEOUT_MS, type ConnectionInput } from '@platform/contracts';
import type { OAuthClientProvider } from '@platform/mcp';
import type { ConnectionAdapter, ConnectionContext } from './adapter.js';
import { observeStdioStderr } from './stdioDiagnostics.js';
import { redactConnectionText } from './connectionDiagnostics.js';
import { awaitConnection } from './awaitConnection.js';
import { toolDispatchFetch } from '@platform/mcp';

type DirectEffects = {
  logStderr: (message: string) => void;
  fetch?: typeof fetch;
  beforeCall?: () => Promise<unknown>;
};
type DirectSession = ReturnType<typeof createSession>;

function createTransport(input: {
  config: ConnectionInput;
  authProvider: OAuthClientProvider;
  fetch: typeof fetch;
}) {
  const { config, authProvider } = input;
  if (config.transport === 'stdio')
    return new ManagedStdioTransport({
      command: config.command!,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      shutdownGraceMs: config.lifecycle.shutdownGraceMs,
    });
  const options = {
    requestInit: { headers: config.headers },
    authProvider,
    fetch: toolDispatchFetch(input.fetch),
  };
  if (config.transport === 'sse') return new SSEClientTransport(new URL(config.url!), options);
  return new StreamableHTTPClientTransport(new URL(config.url!), options);
}

function createSession(input: {
  context: ConnectionContext;
  authProvider: OAuthClientProvider;
  effects: DirectEffects;
  signal: AbortSignal;
  onClose: () => void;
  notify: (event: McpNotification) => void;
}) {
  const { config } = input.context;
  const client = new Client(
    { name: 'mcp-platform', version: '0.1.0' },
    {
      capabilities: input.context.capabilities,
      versionNegotiation: { mode: config.transport === 'sse' ? 'legacy' : 'auto' },
      inputRequired: { autoFulfill: false },
    },
  );
  const transport = createTransport({
    config,
    authProvider: input.authProvider,
    fetch: input.effects.fetch ?? fetch,
  });
  const interactive = new InteractiveClient(
    client,
    Boolean(input.context.capabilities?.elicitation),
  );
  const diagnose =
    transport instanceof ManagedStdioTransport && transport.stderr
      ? observeStdioStderr(transport.stderr, {
          redact: (message) => redactConnectionText(message, config),
          log: input.effects.logStderr,
        })
      : (error: unknown) => error;
  let active = false;
  client.onclose = () => {
    active = false;
    input.onClose();
  };
  const ready = client
    .connect(transport, { timeout: CALL_TIMEOUT_MS, signal: input.signal })
    .then(() => {
      input.signal.throwIfAborted();
      active = true;
      observeNotifications(client, input.notify);
      if (client.getProtocolEra() === 'modern') {
        const capabilities = client.getServerCapabilities();
        const filter = {
          toolsListChanged: capabilities?.tools?.listChanged,
          promptsListChanged: capabilities?.prompts?.listChanged,
          resourcesListChanged: capabilities?.resources?.listChanged,
        };
        if (Object.values(filter).some(Boolean)) return client.listen(filter).then(() => undefined);
      }
    })
    .catch((error: unknown) => {
      throw diagnose(error);
    });
  return { client, interactive, transport, ready, diagnose, active: () => active };
}

export function createDirectAdapter(
  context: ConnectionContext,
  authProvider: OAuthClientProvider,
  effects: DirectEffects,
): ConnectionAdapter {
  const lifetime = new AbortController();
  let session: DirectSession | undefined;
  let catalog: McpCatalog | undefined;
  const listeners = new Set<(event: McpNotification) => void>();
  function acquire() {
    lifetime.signal.throwIfAborted();
    if (session) return session;
    const created = createSession({
      context,
      authProvider,
      effects,
      signal: lifetime.signal,
      notify: (event) => {
        for (const listener of listeners) listener(event);
      },
      onClose: () => {
        if (session === created) session = undefined;
      },
    });
    session = created;
    return created;
  }
  return {
    status: () => (session?.active() ? 'connected' : 'disconnected'),
    watch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async catalog(signal) {
      signal?.throwIfAborted();
      const current = acquire();
      await awaitConnection(current.ready, signal);
      signal?.throwIfAborted();
      catalog = await discoverCatalog(current.client, signal);
      return catalog;
    },
    async discover(signal) {
      return (await this.catalog(signal)).tools;
    },
    async request(operation, options) {
      const current = acquire();
      await awaitConnection(current.ready, options?.signal);
      return executeOperation(current.client, operation, options);
    },
    async call(input) {
      input.signal?.throwIfAborted();
      if (context.config.transport !== 'stdio') await effects.beforeCall?.();
      const current = acquire();
      await awaitConnection(current.ready, input.signal);
      input.signal?.throwIfAborted();
      catalog ??= await discoverCatalog(current.client, input.signal);
      const tool = catalog.tools.find((tool) => tool.name === input.name);
      if (!tool) throw new AppError('TOOL_NOT_DISCOVERED', '请先刷新工具目录', 409);
      try {
        const result = await current.interactive.call({ ...input, tool });
        return isInputRequiredResult(result) ? result : CallToolResultSchema.parse(result);
      } catch (error) {
        if (error instanceof McpValidationError)
          throw new AppError('SCHEMA_VALIDATION', error.message, 422);
        throw new AppError(
          'RESULT_UNKNOWN',
          `上游请求发出后失败，执行结果需确认：${errorMessage(current.diagnose(error))}`,
          502,
        );
      }
    },
    async check(signal) {
      const current = acquire();
      await awaitConnection(current.ready, signal);
      if (current.client.getProtocolEra() === 'modern') await current.client.discover({ signal });
      else await current.client.ping({ signal });
    },
    async close() {
      lifetime.abort(new Error('连接已关闭'));
      const current = session;
      session = undefined;
      listeners.clear();
      try {
        await current?.client.close();
      } finally {
        await current?.transport.close();
      }
    },
  };
}
