import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import { access } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import type { ApiEnv } from './shared/http.js';

export async function mountWeb(app: Hono<ApiEnv>, directory: string) {
  await access(resolve(directory, 'index.html'));
  // The Node adapter resolves static roots relative to the process working directory.
  const root = relative(process.cwd(), directory);
  const files = serveStatic({
    root,
    onFound(path, c) {
      if (path.endsWith('/index.html')) c.header('Cache-Control', 'no-cache');
    },
  });
  const shell = serveStatic({ root, path: 'index.html' });
  for (const path of [
    '/api',
    '/api/*',
    '/mcp',
    '/mcp/*',
    '/.well-known',
    '/.well-known/*',
    '/health',
    '/health/*',
    '/_apps',
    '/_apps/*',
  ])
    app.all(path, (c) => c.notFound());
  app.get('*', files);
  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/assets/') || extname(c.req.path)) return c.notFound();
    c.header('Cache-Control', 'no-cache');
    return shell(c, next);
  });
}
