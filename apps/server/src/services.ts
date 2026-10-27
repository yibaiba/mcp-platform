import { RequestService } from './modules/permissions/requestService.js';
import { requestCatalog } from './modules/permissions/requestCatalog.js';
import { HandoffService } from './modules/handoffs/handoffService.js';
import { AccessService } from './modules/permissions/accessService.js';
import { createOpenApiAdapter } from './modules/openapi/adapter.js';
import { ApiCredentialStore } from './modules/openapi/credentialStore.js';
import { ApiOAuthService } from './modules/openapi/oauthService.js';
import { currentExecution } from './modules/mcp/executionContext.js';
import { RuntimeEvents } from './shared/runtimeEvents.js';
import { InteractionService } from './modules/interactions/interactionService.js';
import { AppSessionService } from './modules/apps/appSessionService.js';
import { resolve } from 'node:path';
import type { Database } from '@platform/db';
import type { Config } from './config.js';
import { Vault } from './shared/crypto.js';
import { DeviceBroker } from './modules/devices/deviceBroker.js';
import { DeviceService, reportDevice } from './modules/devices/deviceService.js';
import { ConnectionService } from './modules/mcp/connectionService.js';
import { createDirectAdapter } from './modules/mcp/directAdapter.js';
import { createDeviceAdapter } from './modules/mcp/deviceAdapter.js';
import { UpstreamOAuth } from './modules/authorizations/upstreamOAuth.js';
import { deviceAuthFetch } from './modules/authorizations/deviceAuthFetch.js';
import { AgentOAuth } from './modules/authorizations/agentOAuth.js';
import { ProfileService } from './modules/agent-profiles/profileService.js';
import { InvocationService } from './modules/mcp/invocationService.js';
import { Gateway } from './modules/mcp/gateway.js';
import { ContentService } from './modules/mcp/contentService.js';
import { SkillService } from './modules/skills/skillService.js';
import { DiskFileStore } from './modules/artifacts/fileStore.js';
import { ArtifactService } from './modules/artifacts/artifactService.js';
import { PiService } from './modules/pi-runtime/piService.js';
export function createServices(db: Database, config: Config) {
  const vault = new Vault(config.ENCRYPTION_KEY);
  const events = new RuntimeEvents();
  const broker = new DeviceBroker((id, message) => reportDevice(db, id, message));
  const devices = new DeviceService(db, broker);
  const upstreamOAuth = new UpstreamOAuth({
    db,
    vault,
    publicUrl: config.PUBLIC_URL,
    fetch,
    fetchFor: (context) =>
      context.config.adapter === 'device' ? deviceAuthFetch(context, broker) : fetch,
  });
  const apiOAuth = new ApiOAuthService({
    store: new ApiCredentialStore({ db, vault }),
    fetch,
    publicUrl: config.PUBLIC_URL,
  });
  const connections: ConnectionService = new ConnectionService({
    db,
    vault,
    devices,
    publicUrl: config.PUBLIC_URL,
    factory: async (context) => {
      if (context.config.source === 'openapi')
        return createOpenApiAdapter(context, {
          fetch,
          artifacts,
          oauth: apiOAuth,
          authorizeArtifact: async (id) => {
            await access.assert(
              { ownerId: context.ownerId, profileId: currentExecution()?.profileId },
              'artifactIds',
              id,
            );
          },
        });
      if (context.config.adapter === 'device')
        return createDeviceAdapter(context, broker, async (): Promise<Record<string, string>> => {
          return upstreamOAuth.headers(context);
        });
      if (context.config.adapter === 'pi') return pi.bridge(context);
      return createDirectAdapter(context, upstreamOAuth.provider(context), {
        fetch: upstreamOAuth.fetchFor(context),
        beforeCall: () => upstreamOAuth.headers(context),
        logStderr: (message) => console.error('MCP stderr', context.id, message),
      });
    },
  });
  const profiles = new ProfileService(db, connections);
  const access = new AccessService({
    db,
    binding: async (ownerId, id) => {
      const context = await connections.context(ownerId, id);
      const binding = await connections.bindings.owned(ownerId, context.bindingId!);
      return `${binding.id}:${binding.revision}:${(await connections.owned(ownerId, id)).revision}`;
    },
  });
  profiles.access = access;
  const artifacts = new ArtifactService({
    db,
    access,
    files: new DiskFileStore(resolve(config.DATA_DIR, 'artifacts')),
    broker,
    devices,
    publicUrl: config.PUBLIC_URL,
  });
  const interactions = new InteractionService({ db, vault });
  const invocations: InvocationService = new InvocationService({
    db,
    profiles,
    connections,
    interactions,
    events,
    onResult: (input) => apps.capture(input),
  });
  const content = new ContentService({ db, profiles, connections });
  const sandboxOrigin =
    config.APPS_ORIGIN ??
    (new URL(config.PUBLIC_URL).hostname === 'localhost'
      ? 'http://localhost:4302'
      : `${new URL(config.PUBLIC_URL).protocol}//apps.${new URL(config.PUBLIC_URL).hostname}`);
  if (
    new URL(sandboxOrigin).origin === new URL(config.PUBLIC_URL).origin ||
    new URL(sandboxOrigin).origin === new URL(config.WEB_ORIGIN).origin
  )
    throw new Error('APPS_ORIGIN 必须与平台使用不同源');
  const apps = new AppSessionService({
    connections,
    content,
    profiles,
    invoke: (input) => invocations.call(input),
    send: (ownerId, input) => pi.start(ownerId, input),
    sandboxOrigin,
  });
  const requests: RequestService = new RequestService({
    db,
    access,
    changed: (id) => gateway.permissionsChanged(id),
    catalog: (access) => requestCatalog({ db, profiles, connections, content }, access),
  });
  const gateway: Gateway = new Gateway({
    access,
    artifacts,
    profiles,
    invocations,
    content,
    connections,
    interactions,
    requests,
  });
  const skills = new SkillService({ db, broker, devices, profiles });
  const agentOAuth = new AgentOAuth({ db, profiles, publicUrl: config.PUBLIC_URL });
  const pi: PiService = new PiService({
    db,
    config,
    profiles,
    invocations,
    skills,
    content,
    artifacts,
    events,
  });
  pi.requests = requests;
  const handoffs = new HandoffService({
    db,
    fail: (id, error) => pi.store.update(id, { status: 'failed', error, endedAt: new Date() }),
    publicUrl: config.PUBLIC_URL,
    start: (ownerId, input, id) => pi.start(ownerId, input, id),
  });
  return {
    requests,
    handoffs,
    broker,
    access,
    events,
    devices,
    apiOAuth,
    interactions,
    apps,
    sandboxOrigin,
    connections,
    upstreamOAuth,
    profiles,
    invocations,
    gateway,
    content,
    skills,
    artifacts,
    agentOAuth,
    pi,
  };
}
export type Services = ReturnType<typeof createServices>;
