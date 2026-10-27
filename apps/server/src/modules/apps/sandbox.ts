import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { framePolicy, resourceInput } from './sandboxPolicy.js';

// This origin has no management API, auth middleware, or platform credentials.
export function sandboxApp(parentOrigins: readonly string[], publicOrigin?: string) {
  const app = new Hono();
  const frames = new Map<string, z.infer<typeof resourceInput>>();
  app.post('/frames', async (c) => {
    if (c.req.header('Origin') !== (publicOrigin ?? new URL(c.req.url).origin))
      return c.text('Invalid origin', 403);
    const input = resourceInput.parse(await c.req.json());
    const id = randomUUID();
    frames.set(id, input);
    return c.json({ path: `/frames/${id}` });
  });
  app.get('/frames/:id', (c) => {
    const resource = frames.get(c.req.param('id'));
    if (!resource) return c.text('App frame ended', 410);
    frames.delete(c.req.param('id'));
    c.header('Content-Security-Policy', framePolicy(resource.csp, parentOrigins));
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), clipboard-write=()');
    c.header('Cache-Control', 'no-store');
    return c.html(resource.html);
  });
  app.get('/sandbox', (c) => {
    const parent = c.req.query('parent');
    if (!parent || !parentOrigins.includes(parent)) return c.text('Unrecognized host origin', 403);
    const script = proxyScript(parent);
    const hash = createHash('sha256').update(script).digest('base64');
    c.header(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; frame-ancestors ${parentOrigins.join(' ')}; base-uri 'none'; form-action 'none'`,
    );
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), clipboard-write=()');
    c.header('Cache-Control', 'no-store');
    return c.html(
      `<!doctype html><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style><script>${script}</script>`,
    );
  });
  return app;
}
function proxyScript(parentOrigin: string) {
  return `(() => {
    const hostOrigin = ${JSON.stringify(parentOrigin)};
    let frame;
    const ready = () => window.parent.postMessage({jsonrpc:'2.0', method:'ui/notifications/sandbox-proxy-ready', params:{}}, hostOrigin);
    window.addEventListener('message', async event => {
      try {
      if (event.source === window.parent && event.origin === hostOrigin) {
        if (event.data?.method === 'platform/proxy-check') { ready(); return; }
        if (event.data?.method === 'ui/notifications/sandbox-resource-ready') {
          const response = await fetch('/frames', {method:'POST', credentials:'omit', headers:{'Content-Type':'application/json'}, body:JSON.stringify(event.data.params)});
          if (!response.ok) throw new Error('App frame creation failed: ' + response.status);
          const {path} = await response.json();
          frame?.remove();
          frame = document.createElement('iframe');
          frame.setAttribute('sandbox', 'allow-scripts allow-forms');
          frame.setAttribute('referrerpolicy','no-referrer');
          frame.src = path;
          document.body.append(frame);
          return;
        }
        frame?.contentWindow?.postMessage(event.data, '*');
        return;
      }
      if (frame && event.source === frame.contentWindow && event.origin === 'null' && !event.data?.method?.startsWith('ui/notifications/sandbox-')) window.parent.postMessage(event.data, hostOrigin);
      } catch (error) {
        window.parent.postMessage({jsonrpc:'2.0',method:'platform/proxy-error',params:{message:String(error)}},hostOrigin);
      }
    });
    ready();
  })();`;
}
