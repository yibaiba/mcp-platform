import { z } from 'zod';

const origin = (connect = false) =>
  z.string().refine((value) => {
    try {
      const url = new URL(value);
      return (
        (connect ? ['https:', 'http:', 'wss:', 'ws:'] : ['https:', 'http:']).includes(
          url.protocol,
        ) &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash &&
        !/[\s;'"<>]/.test(value)
      );
    } catch {
      return false;
    }
  }, 'CSP domain must be an HTTP origin (or WebSocket origin for connections)');
export const resourceInput = z
  .object({
    html: z.string(),
    sandbox: z.string().optional(),
    permissions: z.record(z.string(), z.unknown()).optional(),
    csp: z
      .object({
        resourceDomains: z.array(origin()).default([]),
        connectDomains: z.array(origin(true)).default([]),
        frameDomains: z.array(origin()).default([]),
        baseUriDomains: z.array(origin()).default([]),
      })
      .strict()
      .default({ resourceDomains: [], connectDomains: [], frameDomains: [], baseUriDomains: [] }),
  })
  .strict();
export function framePolicy(csp: z.infer<typeof resourceInput>['csp']) {
  const resources = csp.resourceDomains.join(' ');
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resources}`,
    `style-src 'unsafe-inline' ${resources}`,
    `img-src data: blob: ${resources}`,
    `font-src data: ${resources}`,
    `media-src data: blob: ${resources}`,
    `connect-src ${csp.connectDomains.join(' ') || "'none'"}`,
    `frame-src ${csp.frameDomains.join(' ') || "'none'"}`,
    `base-uri ${csp.baseUriDomains.join(' ') || "'none'"}`,
    "object-src 'none'",
    "form-action 'none'",
    // The opaque data: proxy cannot be named in a frame-ancestors allowlist.
    // The response sandbox still isolates this document, including when opened directly.
    'sandbox allow-scripts allow-forms',
  ].join('; ');
}
