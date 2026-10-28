import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { framePolicy, resourceInput } from './sandboxPolicy.js';

// These routes serve only the trusted proxy and one-use sandbox documents.
export function sandboxApp(parentOrigins: readonly string[], publicOrigin: string, basePath = '') {
  const origin = new URL(publicOrigin).origin;
  const app = new Hono();
  const frames = new Map<string, z.infer<typeof resourceInput>>();
  app.options('/frames', (c) => {
    if (c.req.header('Origin') !== 'null') return c.text('Invalid origin', 403);
    c.header('Access-Control-Allow-Origin', 'null');
    c.header('Access-Control-Allow-Methods', 'POST');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    c.header('Vary', 'Origin');
    return c.body(null, 204);
  });
  app.post('/frames', async (c) => {
    if (c.req.header('Origin') !== 'null') return c.text('Invalid origin', 403);
    c.header('Access-Control-Allow-Origin', 'null');
    c.header('Vary', 'Origin');
    c.header('Cache-Control', 'no-store');
    const input = resourceInput.parse(await c.req.json());
    const id = randomUUID();
    frames.set(id, input);
    return c.json({ path: `${basePath}/frames/${id}` });
  });
  app.get('/frames/:id', (c) => {
    const resource = frames.get(c.req.param('id'));
    if (!resource) return c.text('App frame ended', 410);
    frames.delete(c.req.param('id'));
    c.header('Content-Security-Policy', framePolicy(resource.csp));
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), clipboard-write=()');
    c.header('Cache-Control', 'no-store');
    return c.html(resource.html);
  });
  app.get('/sandbox', (c) => {
    const parent = c.req.query('parent');
    if (!parent || !parentOrigins.includes(parent)) return c.text('Unrecognized host origin', 403);
    const script = proxyScript(parent, `${origin}${basePath}/frames`);
    const requester = c.req.header('Origin');
    if (requester && parentOrigins.includes(requester)) {
      c.header('Access-Control-Allow-Origin', requester);
      c.header('Vary', 'Origin');
    }
    const hash = createHash('sha256').update(script).digest('base64');
    const policy = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src ${origin}; frame-src ${origin}; base-uri 'none'; form-action 'none'`;
    c.header('Content-Security-Policy', `${policy}; frame-ancestors ${parentOrigins.join(' ')}`);
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), clipboard-write=()');
    c.header('Cache-Control', 'no-store');
    return c.html(
      `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style><script>${script}</script>`,
    );
  });
  return app;
}
function proxyScript(parentOrigin: string, framesUrl: string) {
  return `(() => {
    const hostOrigin = ${JSON.stringify(parentOrigin)};
    let frame;
    const ready = () => window.parent.postMessage({jsonrpc:'2.0', method:'ui/notifications/sandbox-proxy-ready', params:{}}, hostOrigin);
    window.addEventListener('message', async event => {
      try {
      if (event.source === window.parent && event.origin === hostOrigin) {
        if (event.data?.method === 'platform/proxy-check') { ready(); return; }
        if (event.data?.method === 'ui/notifications/sandbox-resource-ready') {
          const response = await fetch(${JSON.stringify(framesUrl)}, {method:'POST', credentials:'omit', headers:{'Content-Type':'application/json'}, body:JSON.stringify(event.data.params)});
          if (!response.ok) throw new Error('App frame creation failed: ' + response.status);
          const {path} = await response.json();
          frame?.remove();
          frame = document.createElement('iframe');
          frame.setAttribute('sandbox', 'allow-scripts allow-forms');
          frame.setAttribute('referrerpolicy','no-referrer');
          frame.src = new URL(path, ${JSON.stringify(framesUrl)}).href;
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
