import { Hono } from 'hono';
import { validateConnectorFile, type ConnectorFiles } from './connectorFiles.js';

export function connectorDistributionRoutes(files: ConnectorFiles) {
  const app = new Hono();
  app.get('/install.sh', async (c) => {
    const file = await files.open({ kind: 'installer', name: 'install.sh' });
    return c.body(file.body, 200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });
  app.get('/install.ps1', async (c) => {
    const file = await files.open({ kind: 'installer', name: 'install.ps1' });
    return c.body(file.body, 200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });
  app.get('/downloads/:name', async (c) => {
    const requested = { kind: 'download' as const, name: c.req.param('name') };
    validateConnectorFile(requested);
    const file = await files.open(requested);
    return c.body(file.body, 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${requested.name}"`,
      'Content-Length': String(file.size),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  });
  return app;
}
