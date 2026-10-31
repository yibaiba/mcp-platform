import { BlockList, isIP } from 'node:net';
import { AppError } from './errors.js';

/** One limit: at most `limit` requests per `windowMs`; `limit` 0 turns the limit off. */
export type Rule = { limit: number; windowMs: number };
export type Decision = { ok: true } | { ok: false; retryAfter: number; limit: number };

/**
 * In-memory sliding-window counter (previous window weighted by overlap + current window).
 * Single-process only: every instance counts on its own, so N instances allow up to N× the limit.
 * Rejected requests are not counted, so a client that backs off recovers on schedule.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { start: number; curr: number; prev: number }>();
  private calls = 0;
  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 100_000,
  ) {}

  consume(key: string, rule: Rule): Decision {
    if (rule.limit <= 0) return { ok: true };
    const now = this.now();
    const W = rule.windowMs;
    if (++this.calls % 1000 === 0 || this.buckets.size > this.maxKeys) this.prune(now, W);
    let bucket = this.buckets.get(key);
    const start = Math.floor(now / W) * W;
    if (!bucket) bucket = { start, curr: 0, prev: 0 };
    else if (bucket.start !== start) {
      bucket = { start, curr: 0, prev: start - bucket.start === W ? bucket.curr : 0 };
    }
    const elapsed = now - start;
    const estimate = bucket.prev * (1 - elapsed / W) + bucket.curr;
    if (estimate + 1 > rule.limit) {
      this.buckets.set(key, bucket);
      return { ok: false, retryAfter: retryAfter(bucket, rule, elapsed), limit: rule.limit };
    }
    bucket.curr += 1;
    this.buckets.set(key, bucket);
    return { ok: true };
  }

  private prune(now: number, windowMs: number) {
    for (const [key, bucket] of this.buckets)
      if (now - bucket.start >= 2 * windowMs) this.buckets.delete(key);
    // Still over the cap (many live keys): drop the oldest inserted first.
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= this.maxKeys) break;
      this.buckets.delete(key);
    }
  }
}

/** Seconds until one more request fits under the limit (at least 1). */
function retryAfter(bucket: { curr: number; prev: number }, rule: Rule, elapsed: number) {
  const W = rule.windowMs;
  const room = rule.limit - 1; // the estimate must drop to limit - 1 so the next request fits
  let wait: number;
  if (bucket.curr <= room && bucket.prev > 0) {
    // Still in this window: wait until the previous window's weight has decayed enough.
    wait = W * (1 - (room - bucket.curr) / bucket.prev) - elapsed;
  } else {
    // Wait for the next window, where this window's count becomes the decaying part.
    wait = W - elapsed + (bucket.curr > 0 ? Math.max(0, W * (1 - room / bucket.curr)) : 0);
  }
  return Math.max(1, Math.ceil(wait / 1000));
}

export class RateLimitError extends AppError {
  constructor(
    readonly scope: 'credential' | 'user' | 'ip' | 'auth',
    readonly retryAfter: number,
    readonly limit: number,
  ) {
    super('RATE_LIMITED', `请求太频繁，请 ${retryAfter} 秒后再试`, 429);
  }
}

export function enforce(
  limiter: RateLimiter,
  scope: RateLimitError['scope'],
  key: string,
  rule: Rule,
) {
  const decision = limiter.consume(`${scope}:${key}`, rule);
  if (!decision.ok) throw new RateLimitError(scope, decision.retryAfter, decision.limit);
}

/**
 * Trusted proxy list for X-Forwarded-For: `none`, or a comma list of `loopback`, `private`
 * (RFC 1918, link-local, IPv6 ULA) and CIDRs such as `203.0.113.0/24`.
 */
export function trustedProxies(spec: string) {
  const list = new BlockList();
  for (const raw of spec.split(',').map((item) => item.trim().toLowerCase())) {
    if (!raw || raw === 'none') continue;
    if (raw === 'loopback') {
      list.addSubnet('127.0.0.0', 8, 'ipv4');
      list.addAddress('::1', 'ipv6');
    } else if (raw === 'private') {
      for (const [net, prefix] of [
        ['10.0.0.0', 8],
        ['172.16.0.0', 12],
        ['192.168.0.0', 16],
        ['169.254.0.0', 16],
      ] as const)
        list.addSubnet(net, prefix, 'ipv4');
      list.addSubnet('fc00::', 7, 'ipv6');
      list.addSubnet('fe80::', 10, 'ipv6');
    } else {
      const [net, prefix] = raw.split('/');
      const family = isIP(net ?? '');
      if (!family) throw new Error(`TRUSTED_PROXIES 无法识别：${raw}`);
      const type = family === 4 ? 'ipv4' : 'ipv6';
      if (prefix === undefined) list.addAddress(net!, type);
      else list.addSubnet(net!, Number(prefix), type);
    }
  }
  return list;
}

function normalize(address: string) {
  const value = address.trim().replace(/^\[|\]$/g, '');
  return value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
}
function trusted(list: BlockList, address: string) {
  const family = isIP(address);
  return family !== 0 && list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * The client address: start from the TCP peer and, while that hop is a trusted proxy, step one
 * entry left in X-Forwarded-For. Entries a client wrote itself are never trusted past the first
 * untrusted hop, so a forged header cannot pick an arbitrary address.
 */
export function clientAddress(
  peer: string | undefined,
  forwardedFor: string | undefined,
  list: BlockList,
) {
  let address = peer ? normalize(peer) : '';
  const chain = (forwardedFor ?? '')
    .split(',')
    .map(normalize)
    .filter((entry) => isIP(entry));
  while (address && trusted(list, address) && chain.length) address = chain.pop()!;
  return address || 'unknown';
}
