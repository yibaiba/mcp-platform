import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { calls, tasks, workspaceEvents, type Database } from '@platform/db';
import { callInput } from '@platform/contracts';
import { owner, paramId, type ApiEnv } from '../../shared/http.js';
import { requireValue, AppError } from '../../shared/errors.js';
import { withExecution, PLATFORM_CAPABILITIES } from '../mcp/executionContext.js';
import type { Services } from '../../services.js';
export function workspaceRoutes(deps: { db: Database; services: Services }) {
  const { db, services: s } = deps;
  const app = new Hono<ApiEnv>();
  app.get('/profiles/:id', async (c) => c.json(await s.profiles.owned(owner(c), paramId(c))));
  app.get('/profiles/:id/impact', async (c) => {
    await s.profiles.owned(owner(c), paramId(c));
    const [runningTasks, runningCalls] = await Promise.all([
      db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.ownerId, owner(c)),
            eq(tasks.profileId, paramId(c)),
            inArray(tasks.status, ['running', 'waiting_authorization']),
          ),
        ),
      db
        .select()
        .from(calls)
        .where(
          and(
            eq(calls.ownerId, owner(c)),
            eq(calls.profileId, paramId(c)),
            inArray(calls.status, ['running', 'waiting']),
          ),
        ),
    ]);
    return c.json({
      tasks: runningTasks,
      calls: runningCalls,
      sessions: s.connections.sessions(owner(c), { profileId: paramId(c) }),
      effect: '保存身份配置会结束此 Agent 的执行上下文；不会撤销其他 Agent 的共享绑定。',
    });
  });
  app.use('/profiles/:id/agent/*', async (c, next) => {
    const profile = await s.profiles.owned(owner(c), paramId(c));
    await withExecution(
      {
        ownerId: owner(c),
        profileId: profile.id,
        identity: `test:${profile.id}`,
        entry: 'dashboard',
        sessionId: `test:${profile.id}`,
        capabilities: PLATFORM_CAPABILITIES,
        signal: c.req.raw.signal,
      },
      next,
    );
  });
  app.get('/profiles/:id/agent/catalog', async (c) =>
    c.json({
      tools: await s.profiles.catalog(owner(c), paramId(c)),
      content: await s.content.catalog({ ownerId: owner(c), profileId: paramId(c) }),
      permissions: await s.access.effective({ ownerId: owner(c), profileId: paramId(c) }),
    }),
  );
  app.get('/profiles/:id/agent/connections/:connectionId', async (c) => {
    const context = await s.connections.context(owner(c), paramId(c, 'connectionId'));
    const binding = await s.connections.bindings.owned(owner(c), context.bindingId!);
    return c.json({
      connectionId: context.id,
      bindingId: context.bindingId,
      bindingRevision: binding.revision,
      identity: context.identity,
      deviceId: context.config.deviceId,
      adapter: context.config.adapter,
      credentialEnv: context.config.credentialEnv,
      credentialHeaders: context.config.credentialHeaders,
    });
  });
  for (const action of ['discover', 'check'] as const)
    app.post(`/profiles/:id/agent/connections/:connectionId/${action}`, async (c) =>
      c.json(
        action === 'discover'
          ? await s.connections
              .discover(owner(c), paramId(c, 'connectionId'))
              .then(() => s.profiles.catalog(owner(c), paramId(c), paramId(c, 'connectionId')))
          : await s.connections.check(owner(c), paramId(c, 'connectionId')),
      ),
    );
  app.post('/profiles/:id/agent/tools/:toolId/call', async (c) => {
    const input = callInput.parse(await c.req.json());
    return c.json(
      await s.invocations.dispatch({
        ownerId: owner(c),
        profileId: paramId(c),
        toolId: c.req.param('toolId'),
        ...input,
        signal: c.req.raw.signal,
      }),
    );
  });
  app.post('/profiles/:id/agent/resources/read', async (c) =>
    c.json(
      await s.content.read({
        ownerId: owner(c),
        profileId: paramId(c),
        ...z
          .object({ uri: z.string() })
          .strict()
          .parse(await c.req.json()),
        signal: c.req.raw.signal,
      }),
    ),
  );
  app.post('/profiles/:id/agent/prompts/:entryId/get', async (c) =>
    c.json(
      await s.content.prompt({
        ownerId: owner(c),
        profileId: paramId(c),
        id: c.req.param('entryId'),
        ...z
          .object({ arguments: z.record(z.string(), z.string()).default({}) })
          .strict()
          .parse(await c.req.json()),
        signal: c.req.raw.signal,
      }),
    ),
  );
  app.get('/permission-requests', async (c) => c.json(await s.requests.list(owner(c))));
  app.post('/permission-requests/:id/decide', async (c) =>
    c.json(await s.requests.decide(owner(c), paramId(c), await c.req.json())),
  );
  app.get('/temporary-grants', async (c) => c.json(await s.requests.grants(owner(c))));
  app.delete('/temporary-grants/:id', async (c) =>
    c.json(await s.requests.revoke(owner(c), paramId(c))),
  );
  app.get('/tasks/:id', async (c) =>
    c.json({
      ...(await s.pi.store.detail(owner(c), paramId(c))),
      apps: s.apps.list(owner(c), paramId(c)),
    }),
  );
  app.get('/calls/:id', async (c) => {
    const [row] = await db
      .select()
      .from(calls)
      .where(and(eq(calls.id, paramId(c)), eq(calls.ownerId, owner(c))));
    return c.json(requireValue(row));
  });
  app.get('/handoffs', async (c) => c.json(await s.handoffs.list(owner(c))));
  app.post('/handoffs/preview', async (c) =>
    c.json(await s.handoffs.preview(owner(c), await c.req.json())),
  );
  app.post('/handoffs', async (c) =>
    c.json(await s.handoffs.create(owner(c), await c.req.json()), 201),
  );
  app.get('/handoffs/:id', async (c) => c.json(await s.handoffs.owned(owner(c), paramId(c))));
  app.get('/handoffs/:id/export', async (c) =>
    c.json(await s.handoffs.export(owner(c), paramId(c))),
  );
  app.post('/handoffs/:id/execute', async (c) =>
    c.json(await s.handoffs.execute(owner(c), paramId(c))),
  );
  app.put('/connections/:id/bindings/:bindingId/credentials', async (c) => {
    const context = await s.connections.bindings.owned(owner(c), c.req.param('bindingId'));
    if (context.connectionId !== paramId(c))
      throw new AppError('NOT_FOUND', '绑定与连接不匹配', 404);
    await s.connections.bindings.credentials(owner(c), context.id, await c.req.json());
    await withExecution(
      {
        ownerId: owner(c),
        identity: context.identity,
        bindingIdentity: context.identity,
        entry: 'dashboard',
        sessionId: 'credentials',
        capabilities: {},
      },
      async () => s.connections.closeBinding(await s.connections.context(owner(c), paramId(c))),
    );
    await s.access.changed();
    return c.json({ saved: true });
  });
  app.get('/connections/:id/bindings/:bindingId/impact', async (c) => {
    const binding = await s.connections.bindings.owned(owner(c), c.req.param('bindingId'));
    if (binding.connectionId !== paramId(c))
      throw new AppError('NOT_FOUND', '绑定与连接不匹配', 404);
    return c.json({
      sessions: s.connections.sessions(owner(c), { bindingId: binding.id }),
      calls: await db
        .select()
        .from(calls)
        .where(
          and(
            eq(calls.ownerId, owner(c)),
            eq(calls.bindingId, binding.id),
            inArray(calls.status, ['running', 'waiting']),
          ),
        ),
      effect: '撤销共享绑定将结束全部依赖该绑定的执行上下文',
    });
  });
  app.get('/workspace/events/:id', async (c) =>
    c.json(
      await db
        .select()
        .from(workspaceEvents)
        .where(
          and(eq(workspaceEvents.ownerId, owner(c)), eq(workspaceEvents.aggregateId, paramId(c))),
        )
        .orderBy(workspaceEvents.revision),
    ),
  );
  return app;
}
