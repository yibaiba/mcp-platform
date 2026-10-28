import { z } from 'zod';
import type { ConfigExportService } from './exportService.js';
import { Hono } from 'hono';
import { owner, type ApiEnv } from '../../shared/http.js';
import type { ManifestService } from './manifestService.js';
import type { ConfigSecrets } from './secretService.js';
export function configurationRoutes(deps: {
  manifests: ManifestService;
  secrets: ConfigSecrets;
  configExport: ConfigExportService;
}) {
  const app = new Hono<ApiEnv>();
  app.get('/export', async (c) =>
    c.json(
      await deps.configExport.export(
        owner(c),
        z
          .string()
          .min(1)
          .parse(c.req.query('name') ?? 'platform'),
      ),
    ),
  );
  app.get('/manifests', async (c) => c.json(await deps.manifests.list(owner(c))));
  app.post('/manifests/preview', async (c) =>
    c.json(await deps.manifests.preview(owner(c), await c.req.json())),
  );
  app.post('/manifests/apply', async (c) =>
    c.json(await deps.manifests.apply(owner(c), await c.req.json())),
  );
  app.get('/manifests/:name', async (c) =>
    c.json(await deps.manifests.status(owner(c), c.req.param('name'))),
  );
  app.get('/secrets', async (c) => c.json(await deps.secrets.list(owner(c))));
  app.put('/secrets', async (c) => c.json(await deps.secrets.save(owner(c), await c.req.json())));
  return app;
}
