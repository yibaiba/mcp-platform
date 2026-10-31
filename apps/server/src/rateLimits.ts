import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { clientIpHeader } from '@platform/auth';
import type { Config } from './config.js';
import type { Principal } from './modules/agent-profiles/profileService.js';
import {
  RateLimiter,
  RateLimitError,
  clientAddress,
  enforce,
  trustedProxies,
  type Rule,
} from './shared/rateLimit.js';

const MINUTE = 60_000;
/** Public sign-in / OAuth / CLI-login / pairing endpoints that share the per-address auth limit. */
const authPaths = [
  /^\/api\/v1\/auth\/(?!get-session$|sign-out$)/,
  /^\/api\/v1\/oauth\/(register|authorize|token|revoke)$/,
  /^\/api\/v1\/cli\/(authorize|token)$/,
  /^\/api\/v1\/devices\/pair$/,
];

/**
 * HTTP edge limits. MCP: per client address before authentication, then per credential (access
 * key or OAuth grant, scoped to its Agent) and per user after it. Auth endpoints: per address.
 */
export function createRateLimits(config: Config, limiter = new RateLimiter()) {
  const on = config.RATE_LIMIT_ENABLED === 'true';
  const rule = (limit: number): Rule => ({ limit: on ? limit : 0, windowMs: MINUTE });
  const proxies = trustedProxies(config.TRUSTED_PROXIES);
  const address = (c: Context) => {
    let peer: string | undefined;
    try {
      peer = getConnInfo(c).remote.address;
    } catch {
      peer = undefined; // in-process requests (tests) have no socket
    }
    return clientAddress(peer, c.req.header('x-forwarded-for'), proxies);
  };
  const mcpAddress: MiddlewareHandler = async (c, next) => {
    if (c.req.method !== 'OPTIONS')
      enforce(limiter, 'ip', address(c), rule(config.RATE_LIMIT_MCP_PER_IP));
    await next();
  };
  const authAddress: MiddlewareHandler = async (c, next) => {
    if (c.req.method !== 'OPTIONS' && authPaths.some((path) => path.test(c.req.path)))
      enforce(limiter, 'auth', address(c), rule(config.RATE_LIMIT_AUTH_PER_IP));
    await next();
  };
  const principal = <T extends Principal>(value: T) => {
    enforce(
      limiter,
      'credential',
      `${value.profileId}:${value.credentialId}`,
      rule(config.RATE_LIMIT_MCP_PER_CREDENTIAL),
    );
    enforce(limiter, 'user', value.ownerId, rule(config.RATE_LIMIT_MCP_PER_USER));
    return value;
  };
  /** Hand Better Auth the resolved address instead of a client-controlled header. */
  const authRequest = (c: Context) => {
    const headers = new Headers(c.req.raw.headers);
    headers.set(clientIpHeader, address(c));
    return new Request(c.req.raw, { headers });
  };
  /** Better Auth's own 429 carries only X-Retry-After and an English message. */
  const authResponse = async (response: Response) => {
    if (response.status !== 429) return response;
    const seconds = Math.max(1, Number(response.headers.get('x-retry-after')) || 60);
    const error = new RateLimitError('auth', seconds, config.RATE_LIMIT_LOGIN_PER_IP);
    return new Response(JSON.stringify({ code: error.code, message: error.message }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(seconds),
        'Cache-Control': 'no-store',
      },
    });
  };
  return { mcpAddress, authAddress, principal, authRequest, authResponse };
}
export type RateLimits = ReturnType<typeof createRateLimits>;

/** 429 bodies: JSON-RPC error (id null, as for other transport-level errors) on the MCP endpoint. */
export function rateLimitResponse(c: Context, error: RateLimitError) {
  c.header('Retry-After', String(error.retryAfter));
  c.header('Cache-Control', 'no-store');
  const data = {
    code: error.code,
    scope: error.scope,
    retryAfter: error.retryAfter,
    limit: error.limit,
  };
  if (/^\/mcp\/[^/]+\/?$/.test(c.req.path))
    return c.json(
      { jsonrpc: '2.0', id: null, error: { code: -32000, message: error.message, data } },
      429,
    );
  return c.json(
    {
      code: error.code,
      error: error.message,
      // Better Auth's client (login page) reads `message`.
      message: error.message,
      scope: error.scope,
      retryAfter: error.retryAfter,
    },
    429,
  );
}
