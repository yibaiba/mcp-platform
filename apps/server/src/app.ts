import { bundleRoutes } from './modules/bundles/routes.js';
import { libraryRoutes } from './modules/library/routes.js';
import { platformUpdateRoutes } from './modules/updates/platformRoutes.js';
import { packageUpdateRoutes } from './modules/updates/routes.js';
import { networkRoutes } from './modules/network/routes.js';
import { readFile } from 'node:fs/promises';
import { sshAccessRoutes } from './modules/ssh-access/routes.js';
import { SshAccessService } from './modules/ssh-access/service.js';
import { localRoutes } from './modules/local/routes.js';
import { cliPublicRoutes, cliManagementRoutes } from './modules/management-auth/routes.js';
import { restRoutes } from './modules/rest/routes.js';
import { marketRoutes } from './modules/market/routes.js';
import { configurationRoutes } from './modules/configuration/routes.js';
import { workspaceRoutes } from './modules/workspace/routes.js';
import { withExecution } from './modules/mcp/executionContext.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z, ZodError } from 'zod';
import { desc, eq, sql, and } from 'drizzle-orm';
import {
  calls,
  hasUsers,
  installations,
  transfers,
  oauthGrants,
  type Database,
} from '@platform/db';
import type { Auth } from '@platform/auth';
import { platformRoot, type Config } from './config.js';
import { join } from 'node:path';
import { DiskConnectorFiles, type ConnectorFiles } from './modules/devices/connectorFiles.js';
import { connectorDistributionRoutes } from './modules/devices/distributionRoutes.js';
import { AppError } from './shared/errors.js';
import { bearer, owner, paramId, type ApiEnv } from './shared/http.js';
import { deviceRoutes } from './modules/devices/routes.js';
import { connectionRoutes, toolRoutes } from './modules/mcp/routes.js';
import { contentRoutes } from './modules/mcp/contentRoutes.js';
import { profileRoutes } from './modules/agent-profiles/routes.js';
import { authorizationRoutes } from './modules/authorizations/routes.js';
import { skillRoutes } from './modules/skills/routes.js';
import { artifactRoutes } from './modules/artifacts/routes.js';
import { importGit } from './modules/skills/gitImporter.js';
import { previewOwnedImport, applyImport } from './modules/mcp/importService.js';
import { appRoutes } from './modules/apps/routes.js';
import { interactionRoutes } from './modules/interactions/routes.js';
import { openApiRoutes } from './modules/openapi/routes.js';
import type { Services } from './services.js';
import { sandboxApp } from './modules/apps/sandbox.js';
import { providerList } from '@platform/auth/providers';
import { activeUser } from './modules/users/userAccess.js';
import { UserService } from './modules/users/userService.js';
import { userRoutes } from './modules/users/routes.js';
import { disableUserRuntime } from './modules/users/userRuntime.js';
import { activityRoutes } from './modules/activity/routes.js';
import { logRoutes } from './modules/activity/logRoutes.js';
import { metricsRoutes } from './modules/activity/metrics.js';
import { requestLogging } from './modules/activity/requestLogging.js';
import { shareRoutes } from './modules/shares/routes.js';
import { createRateLimits, rateLimitResponse, type RateLimits } from './rateLimits.js';
import { RateLimitError } from './shared/rateLimit.js';

export function createApp(deps: {
  db: Database;
  auth: Auth;
  config: Config;
  services: Services;
  connectorFiles?: ConnectorFiles;
  rateLimits?: RateLimits;
}) {
  const { db, auth, config, services: s } = deps;
  const limits = deps.rateLimits ?? createRateLimits(config);
  const app = new Hono<ApiEnv>();
  app.route(
    '/_apps',
    sandboxApp(
      [new URL(config.WEB_ORIGIN).origin, new URL(config.PUBLIC_URL).origin],
      config.PUBLIC_URL,
      '/_apps',
    ),
  );
  app.all('/_apps/*', (c) => c.notFound());
  app.use('/api/v1/*', requestLogging(s.logger));
  app.use('/mcp/*', requestLogging(s.logger));
  app.route(
    '/',
    metricsRoutes({ db, config, runtime: s.metrics, online: (id) => s.broker.online(id) }),
  );
  app.use(
    '*',
    cors({
      origin: config.WEB_ORIGIN,
      credentials: true,
      exposeHeaders: ['mcp-session-id', 'X-Content-SHA256', 'X-Call-Id', 'Retry-After'],
      allowHeaders: [
        'Idempotency-Key',
        'Content-Type',
        'Authorization',
        'mcp-session-id',
        'mcp-protocol-version',
        'X-File-Name',
        'X-Content-SHA256',
      ],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );
  app.use('/mcp/*', limits.mcpAddress);
  app.use('/api/v1/*', limits.authAddress);
  app.onError((error, c) => {
    if (error instanceof RateLimitError) return rateLimitResponse(c, error);
    if (error instanceof ZodError)
      return c.json(
        {
          code: 'VALIDATION',
          error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
        400,
      );
    if (error instanceof AppError)
      return c.json({ code: error.code, error: error.message }, error.status as 400);
    s.logger.report('HTTP_UNHANDLED_ERROR', c.get('ownerId'));
    return c.json({ code: 'INTERNAL_ERROR', error: '服务执行失败；请查看服务日志' }, 500);
  });
  app.get('/health', async (c) => {
    await db.execute(sql`select 1`);
    return c.json({ status: 'ok', piEnabled: config.PI_ENABLED === 'true' });
  });
  // `firstAccount`: nobody has signed up yet, so sign-up is open regardless of
  // ALLOW_REGISTRATION and that account becomes administrator.
  app.get('/api/v1/login-options', async (c) => {
    const firstAccount = !(await hasUsers(db));
    return c.json({
      registration: firstAccount || config.ALLOW_REGISTRATION === 'true',
      firstAccount,
      providers: providerList(config.AUTH_PROVIDERS),
    });
  });
  app.on(['GET', 'POST'], '/api/v1/auth/*', async (c) => {
    if (!c.req.path.endsWith('/sign-out')) {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session) await activeUser(db, session.user.id);
    }
    return limits.authResponse(await auth.handler(limits.authRequest(c)));
  });
  app.route(
    '/api/v1/connector',
    connectorDistributionRoutes(
      deps.connectorFiles ??
        new DiskConnectorFiles({
          downloads: join(platformRoot, 'connector/bin'),
          installers: join(platformRoot, 'connector/install'),
        }),
    ),
  );
  app.post('/api/v1/devices/pair', async (c) => {
    const input = z
      .object({ code: z.string().min(1), deviceId: z.uuid().optional() })
      .strict()
      .parse(await c.req.json());
    c.header('Cache-Control', 'no-store');
    return c.json(await s.devices.pair(input.code, input.deviceId), 201);
  });
  app.route('/api/v1/cli', cliPublicRoutes({ auth: s.cliAuth, webOrigin: config.WEB_ORIGIN }));
  registerAgentOAuth(app, deps);
  registerTransfers(app, deps);
  app.get('/mcp/:profileId/artifacts/:id', async (c) => {
    const profileId = paramId(c, 'profileId');
    const principal = limits.principal(
      await s.profiles.authenticate(profileId, bearer(c.req.raw.headers)),
    );
    return withExecution(
      {
        ownerId: principal.ownerId,
        profileId,
        identity: principal.credentialId,
        credentialId: principal.credentialId,
        entry: 'gateway',
        sessionId: 'download',
        capabilities: {},
      },
      async () => {
        await s.access.assert(principal, 'artifactIds', paramId(c));
        return s.artifacts.download(principal.ownerId, paramId(c));
      },
    );
  });
  app.route(
    '/mcp',
    restRoutes({
      services: s,
      publicUrl: config.PUBLIC_URL,
      authenticate: async (profileId, token) =>
        limits.principal(await s.profiles.authenticate(profileId, token)),
    }),
  );
  app.all('/mcp/:profileId', async (c) => {
    const profileId = paramId(c, 'profileId');
    try {
      return await s.gateway.handle(
        c.req.raw,
        limits.principal(await s.profiles.authenticate(profileId, bearer(c.req.raw.headers))),
      );
    } catch (error) {
      if (!(error instanceof AppError) || error.status !== 401) throw error;
      c.header(
        'WWW-Authenticate',
        `Bearer resource_metadata="${config.PUBLIC_URL}/.well-known/oauth-protected-resource/mcp/${profileId}"`,
      );
      return c.json({ error: error.message }, 401);
    }
  });
  app.use('/api/v1/*', async (c, next) => {
    if (c.req.header('authorization')) {
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
        /^\/api\/v1\/(tools|tasks|apps|interactions|calls)(?:\/|$)/.test(c.req.path)
      )
        throw new AppError(
          'AGENT_CREDENTIAL_REQUIRED',
          '业务执行需要 Agent 凭据和 REST 调用接口',
          403,
        );
      const read =
        ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) ||
        ['/api/v1/config/manifests/preview', '/api/v1/cli/logout'].includes(c.req.path);
      const principal = await s.cliAuth.authenticate(
        bearer(c.req.raw.headers),
        read ? 'management:read' : 'management:write',
      );
      c.set('ownerId', principal.user.id);
      c.set('role', principal.user.role);
      c.set('cliGrantId', principal.grantId);
      await next();
      return;
    }
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new AppError('UNAUTHORIZED', '请先登录管理平台', 401);
    const user = await activeUser(db, session.user.id);
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      c.req.header('origin') !== config.WEB_ORIGIN &&
      c.req.header('origin') !== new URL(config.PUBLIC_URL).origin
    )
      throw new AppError('ORIGIN', '管理操作需要匹配的 Origin', 403);
    c.set('ownerId', session.user.id);
    c.set('role', user.role);
    await next();
  });
  app.route('/api/v1/cli', cliManagementRoutes(s.cliAuth));
  app.get('/api/v1/me', async (c) =>
    c.json({
      userId: owner(c),
      role: c.get('role'),
      piEnabled: config.PI_ENABLED === 'true',
      hostStdioEnabled: config.PLATFORM_STDIO_ENABLED === 'true',
      // Effective permission: the deployment switch is on and this caller is an admin.
      hostStdio: config.PLATFORM_STDIO_ENABLED === 'true' && c.get('role') === 'admin',
      // Admins see whether host stdio runs sandboxed and why a sandbox is not usable.
      ...(config.PLATFORM_STDIO_ENABLED === 'true' && c.get('role') === 'admin'
        ? { stdioSandbox: await s.sandbox.status() }
        : {}),
      platformOrigin: new URL(config.PUBLIC_URL).origin,
    }),
  );
  app.route(
    '/api/v1',
    userRoutes(
      new UserService({
        db,
        hashPassword: async (password) => (await auth.$context).password.hash(password),
        disabled: (ownerId) => disableUserRuntime({ db, services: s, ownerId }),
      }),
    ),
  );
  app.route(
    '/api/v1/ssh-accesses',
    sshAccessRoutes({
      service: new SshAccessService({ db, connections: s.connections }),
      readAsset: (name) => readFile(join(platformRoot, 'connector/ssh/windows', name)),
    }),
  );
  app.route('/api/v1/bundles/mcpb', bundleRoutes(s.bundles));
  app.route('/api/v1/library', libraryRoutes(s.library));
  app.route('/api/v1/devices', localRoutes(s.local));
  app.route('/api/v1/devices', deviceRoutes(s.devices));
  app.route('/api/v1/activity/calls', activityRoutes(s.activity));
  app.route('/api/v1/admin/logs', logRoutes({ db, logs: s.logs, logger: s.logger }));
  app.route(
    '/api/v1/connections',
    connectionRoutes(s.connections, () => s.access.changed()),
  );
  app.route(
    '/api/v1/connections',
    authorizationRoutes({
      publicUrl: config.PUBLIC_URL,
      webOrigin: config.WEB_ORIGIN,
      connections: s.connections,
      authorized: (ownerId, id) => s.manifests.dependencyReady(ownerId, id),
      oauth: s.upstreamOAuth,
      pi: s.pi,
      changed: () => s.access.changed(),
    }),
  );
  app.route(
    '/api/v1/connections',
    authorizationRoutes(
      {
        publicUrl: config.PUBLIC_URL,
        webOrigin: config.WEB_ORIGIN,
        connections: s.connections,
        authorized: (ownerId, id) => s.manifests.dependencyReady(ownerId, id),
        oauth: s.upstreamOAuth,
        pi: s.pi,
        changed: () => s.access.changed(),
      },
      true,
    ),
  );
  app.route('/api/v1/tools', toolRoutes(s.profiles, s.invocations));
  app.route('/api/v1', shareRoutes(s.shares));
  app.route('/api/v1/config', configurationRoutes(s));
  app.route('/api/v1/market', marketRoutes(s.market));
  app.route('/api/v1/catalog', contentRoutes(s.content));
  app.route('/api/v1/profiles', profileRoutes({ ...s, publicUrl: config.PUBLIC_URL }));
  app.route('/api/v1', platformUpdateRoutes(s.platformUpdates));
  app.route('/api/v1/connections', packageUpdateRoutes(s.packageUpdates));
  app.route('/api/v1/admin/network-settings', networkRoutes({ db, network: s.network }));
  app.route(
    '/api/v1/skills',
    skillRoutes(s.skills, (input) => importGit(input, s.network)),
  );
  app.route('/api/v1/artifacts', artifactRoutes(s.artifacts));
  app.route('/api/v1', openApiRoutes(s, config.WEB_ORIGIN));
  app.route('/api/v1/interactions', interactionRoutes(s.interactions));
  app.route('/api/v1/apps', appRoutes(s.apps));
  registerManagement(app, deps);
  app.route('/api/v1', workspaceRoutes({ db, services: s }));
  return app;
}
function registerManagement(
  app: Hono<ApiEnv>,
  { db, services: s }: Parameters<typeof createApp>[0],
) {
  app.route('/api/v1', s.events.routes());
  app.post('/api/v1/import/preview', async (c) =>
    c.json(await previewOwnedImport(s.connections, owner(c), await c.req.json())),
  );
  app.post('/api/v1/import/apply', async (c) =>
    c.json(await applyImport(s.connections, owner(c), await c.req.json()), 201),
  );
  app.get('/api/v1/calls', async (c) =>
    c.json(
      await db
        .select()
        .from(calls)
        .where(
          and(
            eq(calls.ownerId, owner(c)),
            ...(['profileId', 'taskId', 'connectionId', 'deviceId'] as const).map((key) =>
              c.req.query(key) ? eq(calls[key], z.uuid().parse(c.req.query(key))) : undefined,
            ),
            c.req.query('status') ? eq(calls.status, c.req.query('status')!) : undefined,
            c.req.query('toolId') ? eq(calls.toolId, c.req.query('toolId')!) : undefined,
          ),
        )
        .orderBy(desc(calls.startedAt))
        .limit(z.coerce.number().int().positive().default(100).parse(c.req.query('limit'))),
    ),
  );
  app.post('/api/v1/calls/:id/cancel', (c) => {
    s.invocations.cancel(owner(c), paramId(c));
    return c.json({ cancellationRequested: true });
  });
  app.get('/api/v1/installations', async (c) =>
    c.json(
      await db
        .select()
        .from(installations)
        .where(eq(installations.ownerId, owner(c))),
    ),
  );
  app.get('/api/v1/transfers', async (c) =>
    c.json(
      await db
        .select({
          id: transfers.id,
          artifactId: transfers.artifactId,
          deviceId: transfers.deviceId,
          status: transfers.status,
          error: transfers.error,
          createdAt: transfers.createdAt,
        })
        .from(transfers)
        .where(eq(transfers.ownerId, owner(c))),
    ),
  );
  app.get('/api/v1/oauth/grants', async (c) =>
    c.json(
      await db
        .select({
          id: oauthGrants.id,
          clientId: oauthGrants.clientId,
          profileId: oauthGrants.profileId,
          revoked: oauthGrants.revoked,
          expiresAt: oauthGrants.expiresAt,
        })
        .from(oauthGrants)
        .where(eq(oauthGrants.ownerId, owner(c))),
    ),
  );
  app.delete('/api/v1/oauth/grants/:id', async (c) => {
    await db
      .update(oauthGrants)
      .set({ revoked: true })
      .where(and(eq(oauthGrants.id, paramId(c)), eq(oauthGrants.ownerId, owner(c))));
    await s.access.changed();
    await s.discovery.invalidateCredential(paramId(c));
    await s.gateway.revoke(paramId(c));
    return c.json({ revoked: true });
  });
  // What the consent page shows: who is asking and exactly which tools they will get.
  app.get('/api/v1/oauth/consent', async (c) => {
    const { value, profileId, clientName } = await s.agentOAuth.validate(c.req.query());
    const profile = await s.profiles.owned(owner(c), profileId);
    const tools = await s.profiles.catalog(owner(c), profileId);
    return c.json({
      clientName,
      redirectUri: value.redirect_uri,
      profile: { id: profile.id, name: profile.name },
      tools: tools.map((tool) => ({
        name: tool.exposedName,
        description: tool.definition.description,
        unavailable: Boolean(tool.unavailable),
      })),
    });
  });
  app.post('/api/v1/oauth/consent', async (c) =>
    c.json(await s.agentOAuth.consent(owner(c), await c.req.json())),
  );
  app.get('/api/v1/tasks', async (c) => c.json(await s.pi.list(owner(c))));
  app.post('/api/v1/tasks', async (c) =>
    c.json(
      await s.pi.start(
        owner(c),
        z
          .object({ profileId: z.uuid(), prompt: z.string().min(1) })
          .strict()
          .parse(await c.req.json()),
      ),
      201,
    ),
  );
  app.post('/api/v1/tasks/:id/cancel', async (c) => {
    await s.pi.cancel(owner(c), paramId(c));
    return c.json({ cancelled: true });
  });
}
function registerAgentOAuth(
  app: Hono<ApiEnv>,
  { config, services: s }: Parameters<typeof createApp>[0],
) {
  app.get('/.well-known/oauth-authorization-server', (c) => c.json(s.agentOAuth.metadata()));
  app.get('/.well-known/oauth-protected-resource/mcp/:profileId', (c) =>
    c.json({
      resource: `${config.PUBLIC_URL}/mcp/${paramId(c, 'profileId')}`,
      authorization_servers: [config.PUBLIC_URL],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
    }),
  );
  app.post('/api/v1/oauth/register', async (c) =>
    c.json(await s.agentOAuth.register(await c.req.json()), 201),
  );
  app.get('/api/v1/oauth/authorize', async (c) => {
    await s.agentOAuth.validate(c.req.query());
    const url = new URL('/authorize', config.WEB_ORIGIN);
    url.search = new URL(c.req.url).search;
    return c.redirect(url.toString());
  });
  app.post('/api/v1/oauth/token', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      return c.json(
        await s.agentOAuth.token(Object.fromEntries(new URLSearchParams(await c.req.text()))),
      );
    } catch (error) {
      if (error instanceof AppError)
        return c.json({ error: error.code, error_description: error.message }, 400);
      if (error instanceof ZodError) return c.json({ error: 'invalid_request' }, 400);
      throw error;
    }
  });
  app.post('/api/v1/oauth/revoke', async (c) => {
    const input = z
      .object({ token: z.string().min(1) })
      .parse(Object.fromEntries(new URLSearchParams(await c.req.text())));
    for (const id of await s.agentOAuth.revoke(input.token)) {
      await s.discovery.invalidateCredential(id);
      await s.gateway.revoke(id);
    }
    await s.access.changed();
    return c.body(null, 200);
  });
}
function registerTransfers(app: Hono<ApiEnv>, { services: s }: Parameters<typeof createApp>[0]) {
  app.get('/api/v1/transfers/:id/content', async (c) => {
    const row = await s.artifacts.claim(paramId(c), bearer(c.req.raw.headers), 'receive');
    return s.artifacts.download(row.ownerId, row.artifactId!);
  });
  app.post('/api/v1/transfers/:id/content', async (c) => {
    const row = await s.artifacts.claim(paramId(c), bearer(c.req.raw.headers), 'send');
    const artifact = await s.artifacts.upload(row.ownerId, {
      name: decodeURIComponent(c.req.header('x-file-name') ?? ''),
      sha256: c.req.header('x-content-sha256') ?? '',
      body: c.req.raw.body,
    });
    await s.artifacts.attach(row.id, artifact.id);
    return c.json(artifact, 201);
  });
}
