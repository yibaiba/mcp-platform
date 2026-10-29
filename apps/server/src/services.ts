import { CliAuthService } from './modules/management-auth/cliAuthService.js';
import { RuntimeMetrics } from './modules/activity/runtimeMetrics.js';
import { HnswStore } from './modules/discovery/hnswStore.js';
import { RestService } from './modules/rest/restService.js';
import { RestCallStore } from './modules/rest/callStore.js';
import { EncryptedResultStore } from './modules/rest/resultStore.js';
import { DiscoveryService } from './modules/discovery/discoveryService.js';
import { EmbeddingClient } from './modules/discovery/embeddingClient.js';
import { VectorStore } from './modules/discovery/vectorStore.js';
import { MarketService } from './modules/market/marketService.js';
import { RegistryClient, OFFICIAL_REGISTRY } from './modules/market/registryClient.js';
import { ConfigExportService } from './modules/configuration/exportService.js';
import { ManifestService } from './modules/configuration/manifestService.js';
import { ConfigSecrets } from './modules/configuration/secretService.js';
import { DeploymentPending } from './modules/configuration/values.js';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
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
import { connectionShares, devices as deviceRows } from '@platform/db';
import { eq } from 'drizzle-orm';
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
import { ActivityService } from './modules/activity/activityService.js';
import { LogService } from './modules/activity/logService.js';
import { databaseLogger } from './modules/activity/systemLogger.js';
import { ShareService } from './modules/shares/shareService.js';
export function createServices(db: Database, config: Config) {
  const metrics = new RuntimeMetrics();
  const vault = new Vault(config.ENCRYPTION_KEY);
  const logger = databaseLogger(db);
  const shares: ShareService = new ShareService({
    db,
    vault,
    validate: (ownerId, input) => connections.validate(ownerId, input),
    recovery: (ownerId, id) => connections.recovery(ownerId, id),
    changed: async (shareId) => {
      const [share] = await db
        .select()
        .from(connectionShares)
        .where(eq(connectionShares.id, shareId));
      const recipients = share ? await profiles.list(share.recipientId) : [];
      const outcomes = await Promise.allSettled([
        connections.closeShare(shareId),
        access.changed(),
        ...recipients.map((profile) => gateway.permissionsChanged(profile.id)),
      ]);
      const failures = outcomes
        .filter((outcome) => outcome.status === 'rejected')
        .map((outcome) => outcome.reason);
      if (failures.length)
        throw new AggregateError(failures, '共享授权已更新；运行时清理或通知失败');
    },
  });
  const events = new RuntimeEvents();
  const broker = new DeviceBroker(async (id, message) => {
    await reportDevice(db, id, message);
    if (message.type === 'hello') {
      const [device] = await db
        .select({ ownerId: deviceRows.ownerId })
        .from(deviceRows)
        .where(eq(deviceRows.id, id));
      if (device)
        void manifests
          .deviceReady(device.ownerId, id)
          .catch(() => logger.report('MANIFEST_DEVICE_READY_FAILED', device.ownerId));
    }
  }, logger);
  const devices = new DeviceService({
    db,
    broker,
    vault: new Vault(config.DEVICE_AUTH_ENCRYPTION_KEY),
    platformOrigin: new URL(config.PUBLIC_URL).origin,
  });
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
    logger,
    shares,
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
        logStderr: () => logger.report('MCP_STDERR', context.ownerId),
      });
    },
  });
  const profiles = new ProfileService(db, connections, shares);
  const access = new AccessService({
    logger,
    db,
    shares,
    binding: async (ownerId, id) => {
      const context = await connections.context(ownerId, id);
      const binding = await connections.bindings.owned(ownerId, context.bindingId!);
      return `${binding.id}:${binding.revision}:${(await connections.accessible(ownerId, id)).revision}:${context.shareVersion ?? ''}`;
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
    changed: (id) => gateway.permissionsChanged(id),
  });
  const interactions = new InteractionService({ db, vault, logger });
  const invocations: InvocationService = new InvocationService({
    metrics,
    logger,
    db,
    profiles,
    connections,
    interactions,
    events,
    onResult: (input) => apps.capture(input),
  });
  const content = new ContentService({ db, profiles, connections, shares, logger });
  const sandboxOrigin = new URL(config.PUBLIC_URL).origin;
  const apps = new AppSessionService({
    connections,
    content,
    profiles,
    invoke: (input) => invocations.call(input),
    send: (ownerId, input) => pi.start(ownerId, input),
    sandboxOrigin,
  });
  const requests: RequestService = new RequestService({
    logger,
    db,
    shares,
    access,
    changed: (id) => gateway.permissionsChanged(id),
    catalog: (access) => requestCatalog({ db, profiles, connections, content }, access),
  });
  const gateway: Gateway = new Gateway({
    webOrigin: config.WEB_ORIGIN,
    access,
    artifacts,
    logger,
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
    logger,
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
  const secrets = new ConfigSecrets({
    db,
    vault,
    changed: (ownerId) => manifests.refresh(ownerId).then(() => undefined),
  });
  const manifests: ManifestService = new ManifestService({
    db,
    connections,
    profiles,
    shares,
    secrets,
    logger,
    directory: async (path) => {
      if (!isAbsolute(path)) throw new DeploymentPending('目录映射必须使用执行位置的绝对路径');
      try {
        if ((await stat(path)).isDirectory()) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      throw new DeploymentPending('映射目录不存在或不是目录');
    },
    changed: async (id) => {
      await access.changed();
      await connections.closeProfile(id);
      await gateway.profileChanged(id);
      await pi.revokeProfile(id);
    },
  });
  profiles.discovery = new DiscoveryService({
    metrics,
    profiles,
    connections,
    secrets,
    embeddings: new EmbeddingClient(fetch),
    vectors: new VectorStore(db),
    hnsw: new HnswStore(db),
  });
  connections.watchCatalog((ownerId) => manifests.schedule(ownerId));
  const rest = new RestService({
    profiles,
    invocations,
    interactions,
    logger,
    store: new RestCallStore(db, vault),
    results: new EncryptedResultStore(resolve(config.DATA_DIR, 'rest-results'), vault),
  });
  return {
    cliAuth: new CliAuthService(db),
    metrics,
    rest,
    manifests,
    discovery: profiles.discovery,
    secrets,
    configExport: new ConfigExportService({ db, vault }),
    market: new MarketService({
      registry: new RegistryClient({ fetch, baseUrl: OFFICIAL_REGISTRY }),
      connections,
    }),
    shares,
    activity: new ActivityService({ db, vault }),
    logs: new LogService({ db, vault }),
    logger,
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
