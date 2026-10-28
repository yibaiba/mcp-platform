import {
  discoverCatalog,
  executeOperation,
  InteractiveClient,
  toolDispatchFetch,
  auth,
  ManagedStdioTransport,
  observeNotifications,
  type Client,
  type McpCatalog,
  type McpOperation,
  type OAuthClientProvider,
} from '@platform/mcp';
import { randomUUID } from 'node:crypto';
import type { Context } from './runtime.js';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type ExtensionContext,
  type AgentToolResult,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
const adapterPackage: string = 'pi-mcp-adapter';
const { createMcpAdapter, getMcpClient, configurePlatformEmbedding } = (await import(
  adapterPackage
)) as {
  configurePlatformEmbedding(options: {
    oauthRedirectUri?: string;
    authorize: (
      action: () => Promise<'AUTHORIZED' | 'REDIRECT'>,
    ) => Promise<'AUTHORIZED' | 'REDIRECT'>;
    wrapFetch: (
      fetch: typeof globalThis.fetch,
      authorization?: { provider: OAuthClientProvider; serverUrl: string },
    ) => typeof globalThis.fetch;
    capabilities?: Record<string, unknown>;
    createStdio: (
      options: ConstructorParameters<typeof ManagedStdioTransport>[0],
    ) => ManagedStdioTransport;
    onClient: (client: Client) => void;
  }): void;
  getMcpClient(options: { pi: ExtensionAPI; name: string }): Client;
  createMcpAdapter(options: { config: Record<string, unknown> }): ExtensionFactory;
};
let session: AgentSession | undefined;
let extension: ExtensionAPI;
let catalog: McpCatalog | undefined;
const observed = new WeakSet<Client>();
const interactive = new WeakMap<Client, InteractiveClient>();
function client() {
  const current = getMcpClient({ pi: extension, name: server });
  if (!observed.has(current)) {
    observed.add(current);
    observeNotifications(current, (notification) =>
      sendToParent({ type: 'notification', notification }),
    );
  }
  return current;
}
let server = '';
let serverUrl = '';
let requestTimeoutMs: number | undefined;
let healthTimeoutMs: number | undefined;
const active = new Map<string, AbortController>();
const authGrants = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
function sendToParent(message: Record<string, unknown>) {
  const failed = (error: Error | null) => {
    if (!error) return;
    console.error('Pi bridge IPC delivery failed; pending execution cannot be reported', error);
    for (const grant of authGrants.values()) grant.reject(error);
    authGrants.clear();
    for (const abort of active.values()) abort.abort(error);
  };
  if (!process.connected || !process.send) {
    failed(new Error('Pi parent channel disconnected'));
    return;
  }
  process.send(message, undefined, undefined, failed);
}

async function authorize(action: () => Promise<'AUTHORIZED' | 'REDIRECT'>) {
  const id = randomUUID();
  await new Promise<void>((resolve, reject) => {
    authGrants.set(id, { resolve, reject });
    sendToParent({ type: 'auth-acquire', id });
  });
  try {
    return await action();
  } finally {
    sendToParent({ type: 'auth-release', id });
  }
}
async function proxy(params: Record<string, unknown>, signal?: AbortSignal) {
  if (!session) throw new Error('Pi bridge is not initialized');
  const tool = session.getToolDefinition('mcp');
  if (!tool) throw new Error('Pi MCP proxy tool was not registered');
  // The adapter proxy accepts ExtensionContext for non-model programmatic calls.
  // The agent's model-bound wrapper requires an assistant tool-call message.
  const execute = tool.execute as (
    id: string,
    args: unknown,
    signal: AbortSignal | undefined,
    update: undefined,
    context: ExtensionContext,
  ) => Promise<AgentToolResult<Record<string, unknown>>>;
  const result = await execute(
    randomUUID(),
    params,
    signal,
    undefined,
    session.extensionRunner.createContext(),
  );
  const details = result.details as Record<string, unknown> | undefined;
  if (details?.error && details.error !== 'tool_error')
    throw Object.assign(
      new Error(
        `${details.error}: ${result.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')}`,
      ),
      { code: String(details.error) },
    );
  return { content: result.content, details };
}
async function dispatch(
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  requestId: string,
) {
  if (method === 'initialize') {
    const context = params as Context;
    requestTimeoutMs = context.config.requestOptions?.timeoutMs;
    healthTimeoutMs = context.config.health?.timeoutMs;
    configurePlatformEmbedding({
      oauthRedirectUri: context.oauthRedirectUri,
      authorize,
      wrapFetch: (delegate, authorization) =>
        toolDispatchFetch(delegate, async (): Promise<Record<string, string>> => {
          if (!authorization) return {};
          const { provider, serverUrl } = authorization;
          let tokens = await provider.tokens();
          if (tokens?.expires_in !== undefined && tokens.expires_in <= 0) {
            if ((await auth(provider, { serverUrl, fetchFn: delegate })) !== 'AUTHORIZED')
              throw new Error('Pi 上游授权已过期，请重新授权');
            tokens = await provider.tokens();
          }
          return tokens ? { Authorization: `Bearer ${tokens.access_token}` } : {};
        }),
      capabilities: context.capabilities,
      createStdio: (options) =>
        new ManagedStdioTransport({
          ...options,
          shutdownGraceMs: context.config.lifecycle?.shutdownGraceMs,
        }),
      onClient: (client) =>
        interactive.set(
          client,
          new InteractiveClient(client, Boolean(context.capabilities?.elicitation)),
        ),
    });
    server = `u_${context.ownerId}_c_${context.bindingId ?? context.id}`;
    serverUrl = context.config.url ?? '';
    const directory = process.env.PI_CODING_AGENT_DIR!;
    const settings = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager: settings,
      noExtensions: true,
      disabledBuiltinExtensions: ['mcp'],
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      noThemes: true,
      extensionFactories: [
        (pi) => {
          extension = pi;
          return createMcpAdapter({
            config: {
              mcpServers: {
                [server]: {
                  ...(context.config.transport === 'stdio'
                    ? {
                        command: context.config.command,
                        args: context.config.args,
                        env: context.config.env,
                        literalEnv: true,
                        cwd: context.config.cwd ?? process.cwd(),
                        debug: true,
                      }
                    : {
                        url: context.config.url,
                        httpTransport:
                          context.config.transport === 'sse' ? 'sse' : 'streamable-http',
                        headers: context.config.headers,
                        oauth: context.config.oauth,
                      }),
                  lifecycle: 'lazy',
                  requestTimeoutMs: context.config.connectTimeoutMs,
                  roots: false,
                  protocolVersion: context.config.transport === 'sse' ? 'legacy' : 'auto',
                },
              },
              settings: {
                oauthCredentialStore: 'encrypted-file',
                autoAuth: false,
                outputGuard: false,
              },
            },
          })(pi);
        },
      ],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: SessionManager.inMemory(),
      noTools: 'builtin',
    }));
    await session.bindExtensions({});
    return { ready: true };
  }
  if (!session) throw new Error('Pi bridge is not initialized');
  if (method === 'close') {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose();
    session = undefined;
    return { closed: true };
  }
  const onprogress = params.progress
    ? (progress: unknown) => sendToParent({ type: 'progress', id: requestId, progress })
    : undefined;
  if (method === 'catalog' || method === 'discover') {
    await proxy({ connect: server }, signal);
    catalog = await discoverCatalog(client(), signal, requestTimeoutMs);
    return method === 'discover' ? catalog.tools : catalog;
  }
  if (method === 'request' || method === 'call' || method === 'check') {
    if (!catalog) {
      await proxy({ connect: server }, signal);
      catalog = await discoverCatalog(client(), signal, requestTimeoutMs);
    }
  }
  if (method === 'check') {
    if (client().getProtocolEra() === 'modern')
      await client().discover({ signal, timeout: healthTimeoutMs });
    else await client().ping({ signal, timeout: healthTimeoutMs });
    return {};
  }
  if (method === 'request')
    return executeOperation(client(), params.operation as McpOperation, {
      signal,
      onprogress,
      executionTimeoutMs: params.executionTimeoutMs as number | undefined,
    });
  if (method === 'interaction.cancel')
    return interactive.get(client())!.cancel(String(params.requestState));
  if (method === 'call') {
    const tool = catalog?.tools.find((tool) => tool.name === params.name);
    if (!tool) throw new Error('Pi tool has not been discovered');
    return interactive.get(client())!.call({
      tool,
      arguments: params.arguments as Record<string, unknown>,
      signal,
      onprogress,
      requestState: params.requestState as string | undefined,
      inputResponses: params.inputResponses as Record<string, unknown> | undefined,
    });
  }
  if (method === 'action') {
    if (params.action === 'status') return proxy({ server }, signal);
    if (!process.env.PI_MCP_ADAPTER_OAUTH_FILE_KEY)
      throw new Error('Pi OAuth 需要配置 PI_MCP_ADAPTER_OAUTH_FILE_KEY（32 随机字节的 base64）');
    if (params.action === 'logout') {
      await session.prompt(`/mcp-adapter logout ${server}`);
      const oauthModule: string = 'pi-mcp-adapter/oauth';
      const oauth = (await import(oauthModule)) as {
        inspectMcpOAuthTokensForUrl: (
          name: string,
          url: string,
          options: { credentialStore: string },
        ) => { status: string; message?: string };
      };
      const status = oauth.inspectMcpOAuthTokensForUrl(server, serverUrl, {
        credentialStore: 'encrypted-file',
      });
      if (status.status !== 'absent')
        throw new Error(status.message ?? 'Pi OAuth tokens still exist after logout');
      return { tokensRemoved: true, upstreamRevocation: '请在供应商账户中撤销授权' };
    }
    return proxy({ ...params, server }, signal);
  }
  throw new Error(`Unsupported Pi bridge operation: ${method}`);
}
process.on(
  'message',
  (message: { type: string; id: string; method: string; params: Record<string, unknown> }) => {
    if (message.type === 'cancel') {
      active.get(message.id)?.abort();
      return;
    }
    if (message.type === 'auth-granted') {
      const grant = authGrants.get(message.id);
      authGrants.delete(message.id);
      if ('error' in message) grant?.reject(new Error(String(message.error)));
      else grant?.resolve();
      return;
    }
    const abort = new AbortController();
    active.set(message.id, abort);
    void dispatch(message.method, message.params, abort.signal, message.id)
      .then(
        (result) => sendToParent({ id: message.id, result }),
        (error: unknown) =>
          sendToParent({
            id: message.id,
            error: error instanceof Error ? error.message : String(error),
            errorName: error instanceof Error ? error.name : undefined,
            errorCode: error instanceof Error && 'code' in error ? String(error.code) : undefined,
          }),
      )
      .finally(() => active.delete(message.id));
  },
);
process.on('disconnect', () => {
  for (const grant of authGrants.values())
    grant.reject(new Error('Pi authorization channel disconnected'));
  authGrants.clear();
  for (const abort of active.values()) abort.abort();
  void (async () => {
    await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session?.dispose();
  })().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error('Pi bridge disconnect cleanup failed', error);
      process.exit(1);
    },
  );
});
