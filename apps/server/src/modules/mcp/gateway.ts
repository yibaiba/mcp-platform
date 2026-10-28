import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createMcpHandler,
  isLegacyRequest,
  isInitializeRequest,
  WebStandardStreamableHTTPServerTransport,
  readRequestBody,
  type McpHttpHandler,
  type Server,
} from '@modelcontextprotocol/server';
import type { Principal } from '../agent-profiles/profileService.js';
import { createGatewayServer, type GatewayHandlers } from './gatewayHandlers.js';
import type { ConnectionService, ConnectionEvent } from './connectionService.js';
import { scopedUri } from './catalogEntries.js';
import { ResourceSubscriptions } from './resourceSubscriptions.js';
import { streamFinally } from './gatewayStream.js';
import { withExecution } from './executionContext.js';
import { AppError } from '../../shared/errors.js';

type Session = {
  principal: Principal;
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  channel: string;
};
type Modern = { principal: Principal; handler: McpHttpHandler; channels: Set<string> };
const listenRequest = z.object({
  method: z.literal('subscriptions/listen'),
  params: z.object({
    notifications: z.object({ resourceSubscriptions: z.array(z.string()).optional() }),
  }),
});

export class Gateway {
  private readonly sessions = new Map<string, Session>();
  private readonly modern = new Map<string, Modern>();
  private readonly subscriptions: ResourceSubscriptions;
  private readonly handlers: GatewayHandlers;
  private readonly unwatch: () => void;
  private readonly unwatchClosing: () => void;
  constructor(
    private readonly deps: Omit<GatewayHandlers, 'subscriptions'> & {
      connections: ConnectionService;
    },
  ) {
    this.subscriptions = new ResourceSubscriptions(deps.content, deps.logger);
    this.handlers = { ...deps, subscriptions: this.subscriptions };
    this.unwatch = deps.connections.watch((event) => this.notify(event));
    this.unwatchClosing = deps.connections.watchClosing((id) => this.connectionClosing(id));
  }
  async handle(request: Request, principal: Principal) {
    if (await isLegacyRequest(request)) return this.legacy(request, principal);
    let entry = this.modern.get(principal.credentialId);
    const channel = `modern:${principal.credentialId}`;
    if (!entry) {
      const handler = createMcpHandler(
        (context) =>
          createGatewayServer({
            ...this.handlers,
            principal: { ...principal, token: context.authInfo?.token ?? principal.token },
            channel,
            era: context.era,
          }),
        { legacy: 'reject', onerror: () => this.deps.logger.report('MCP_GATEWAY_FAILED') },
      );
      entry = { principal, handler, channels: new Set() };
      this.modern.set(principal.credentialId, entry);
    }
    entry.principal.token = principal.token;
    return withExecution(
      {
        identity: principal.credentialId,
        ownerId: principal.ownerId,
        profileId: principal.profileId,
        credentialId: principal.credentialId,
        entry: 'gateway',
        sessionId: channel,
        capabilities: {},
        headers: requestHeaders(request.headers),
      },
      () => this.modernRequest(entry!, request, principal),
    );
  }
  private async modernRequest(entry: Modern, request: Request, principal: Principal) {
    const authInfo = { token: principal.token, clientId: principal.credentialId, scopes: ['mcp'] };
    if (request.method !== 'POST') return entry.handler.fetch(request, { authInfo });
    const body = await readRequestBody(request.clone());
    if (body.tooLarge) return new Response('Request too large', { status: 413 });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return entry.handler.fetch(request, { authInfo });
    }
    const listen = listenRequest.safeParse(parsed);
    if (!listen.success) return entry.handler.fetch(request, { authInfo, parsedBody: parsed });
    const channel = randomUUID();
    entry.channels.add(channel);
    const release = async () => {
      entry.channels.delete(channel);
      await this.subscriptions.release(channel);
    };
    try {
      for (const uri of listen.data.params.notifications.resourceSubscriptions ?? []) {
        await this.subscriptions.subscribe({
          access: { ...principal, principal },
          channel,
          uri,
          signal: request.signal,
          active: () => entry.channels.has(channel),
        });
      }
      const response = await entry.handler.fetch(request, { authInfo, parsedBody: parsed });
      if (!response.ok) {
        await release();
        return response;
      }
      return streamFinally(response, release);
    } catch (error) {
      await release();
      throw error;
    }
  }
  private async legacy(request: Request, principal: Principal) {
    const sessionId = request.headers.get('mcp-session-id');
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (
        !session ||
        session.principal.credentialId !== principal.credentialId ||
        session.principal.profileId !== principal.profileId
      )
        return Response.json({ error: '会话无效，请重新连接' }, { status: 404 });
      session.principal.token = principal.token;
      return withExecution(
        {
          identity: principal.credentialId,
          ownerId: principal.ownerId,
          profileId: principal.profileId,
          credentialId: principal.credentialId,
          entry: 'gateway',
          sessionId: session.channel,
          capabilities: session.server.getClientCapabilities() ?? {},
          headers: requestHeaders(request.headers),
        },
        () => session.transport.handleRequest(request),
      );
    }
    if (request.method !== 'POST') return new Response('MCP session required', { status: 400 });
    const body = await readRequestBody(request.clone());
    if (body.tooLarge) return new Response('Request too large', { status: 413 });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return Response.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        { status: 400 },
      );
    }
    if (!isInitializeRequest(parsed)) return new Response('Initialize required', { status: 400 });
    const channel = randomUUID();
    const server = await withExecution(
      {
        identity: principal.credentialId,
        ownerId: principal.ownerId,
        profileId: principal.profileId,
        credentialId: principal.credentialId,
        entry: 'gateway',
        sessionId: channel,
        capabilities: parsed.params.capabilities,
        headers: requestHeaders(request.headers),
      },
      () =>
        createGatewayServer({
          ...this.handlers,
          principal,
          channel,
          era: 'legacy',
        }),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        this.sessions.set(id, { principal, transport, server, channel });
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
        void this.subscriptions
          .release(channel)
          .catch(() => this.deps.logger.report('RESOURCE_SUBSCRIPTION_CLEANUP_FAILED'));
      },
    });
    await server.connect(transport);
    return transport.handleRequest(request, { parsedBody: parsed });
  }
  private async notify(event: ConnectionEvent) {
    for (const session of this.sessions.values()) {
      if (
        event.sessionId &&
        event.sessionId !== `gateway:${session.principal.credentialId}:${session.channel}`
      )
        continue;
      if (!(await this.visible(session.principal, event))) continue;
      const { method, params } = event.notification;
      if (method === 'notifications/resources/updated') {
        if (typeof params?.uri !== 'string') continue;
        const uri = scopedUri(event.connectionId, params.uri);
        if (this.subscriptions.has(session.channel, uri))
          await session.server.sendResourceUpdated({ uri });
      } else await session.server.notification({ method });
    }
    for (const entry of this.modern.values()) {
      if (
        event.sessionId &&
        event.sessionId !==
          `gateway:${entry.principal.credentialId}:modern:${entry.principal.credentialId}`
      )
        continue;
      if (!(await this.visible(entry.principal, event))) continue;
      const { method, params } = event.notification;
      if (method === 'notifications/tools/list_changed') entry.handler.notify.toolsChanged();
      if (method === 'notifications/prompts/list_changed') entry.handler.notify.promptsChanged();
      if (method === 'notifications/resources/list_changed')
        entry.handler.notify.resourcesChanged();
      if (method === 'notifications/resources/updated' && typeof params?.uri === 'string')
        entry.handler.notify.resourceUpdated(scopedUri(event.connectionId, params.uri));
    }
  }
  private async visible(principal: Principal, event: ConnectionEvent) {
    if (principal.ownerId !== event.ownerId) return false;
    try {
      await this.deps.profiles.authenticate(principal.profileId, principal.token);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'UNAUTHORIZED') throw error;
      await this.revoke(principal.credentialId);
      return false;
    }
    return withExecution(
      {
        ownerId: principal.ownerId,
        profileId: principal.profileId,
        identity: principal.credentialId,
        credentialId: principal.credentialId,
        entry: 'gateway',
        sessionId: 'notification',
        capabilities: {},
      },
      async () => {
        // Permission checks for notifications must not create another upstream session.
        return this.deps.content.eventVisible(principal, {
          connectionId: event.connectionId,
          method: event.notification.method,
          uri:
            typeof event.notification.params?.uri === 'string'
              ? event.notification.params.uri
              : undefined,
        });
      },
    );
  }
  async revoke(credentialId: string) {
    this.deps.invocations.revoke({ credentialId });
    await this.remove((principal) => principal.credentialId === credentialId);
  }
  async revokeOwner(ownerId: string) {
    this.deps.invocations.revoke({ ownerId });
    await this.remove((principal) => principal.ownerId === ownerId);
  }
  private async connectionClosing(context: import('./adapter.js').ConnectionContext) {
    const connectionId = context.id;
    const matches = (credentialId: string, channel: string) =>
      !context.sessionId || context.sessionId === `gateway:${credentialId}:${channel}`;
    const affected = new Set<string>();
    for (const session of this.sessions.values()) {
      if (!matches(session.principal.credentialId, session.channel)) continue;
      if (this.subscriptions.includesConnection(session.channel, connectionId))
        affected.add(session.principal.credentialId);
    }
    for (const entry of this.modern.values()) {
      if (!matches(entry.principal.credentialId, `modern:${entry.principal.credentialId}`))
        continue;
      if (
        [...entry.channels].some((channel) =>
          this.subscriptions.includesConnection(channel, connectionId),
        )
      )
        affected.add(entry.principal.credentialId);
    }
    await this.remove((principal) => affected.has(principal.credentialId));
  }
  async permissionsChanged(profileId: string) {
    for (const session of this.sessions.values()) {
      if (session.principal.profileId !== profileId) continue;
      await session.server.notification({ method: 'notifications/tools/list_changed' });
      await session.server.notification({ method: 'notifications/prompts/list_changed' });
      await session.server.notification({ method: 'notifications/resources/list_changed' });
    }
    for (const entry of this.modern.values()) {
      if (entry.principal.profileId !== profileId) continue;
      entry.handler.notify.toolsChanged();
      entry.handler.notify.promptsChanged();
      entry.handler.notify.resourcesChanged();
    }
  }
  async profileChanged(profileId: string) {
    this.deps.invocations.revoke({ profileId });
    await this.remove((principal) => principal.profileId === profileId);
  }
  private async remove(matches: (principal: Principal) => boolean) {
    for (const [id, session] of this.sessions) {
      if (!matches(session.principal)) continue;
      this.sessions.delete(id);
      await session.server.close();
      await this.subscriptions.release(session.channel);
    }
    for (const [id, entry] of this.modern) {
      if (!matches(entry.principal)) continue;
      this.modern.delete(id);
      await entry.handler.close();
      for (const channel of entry.channels) await this.subscriptions.release(channel);
    }
  }
  async close() {
    this.unwatch();
    this.unwatchClosing();
    await this.remove(() => true);
  }
}

function requestHeaders(headers: Headers) {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}
