import { expect, test } from 'vitest';
import { RateLimiter, clientAddress, trustedProxies } from '../apps/server/src/shared/rateLimit.js';

const minute = { limit: 5, windowMs: 60_000 };

test('allows `limit` requests per window, rejects the next, and does not count rejections', () => {
  let now = 1_000_000 * 60_000; // window aligned
  const limiter = new RateLimiter(() => now);
  for (let i = 0; i < 5; i++) expect(limiter.consume('k', minute)).toEqual({ ok: true });
  const rejected = limiter.consume('k', minute);
  expect(rejected).toMatchObject({ ok: false, limit: 5 });
  // Hammering while limited does not push recovery further out.
  for (let i = 0; i < 50; i++) limiter.consume('k', minute);
  now += 30_000;
  expect(limiter.consume('k', minute)).toMatchObject({ ok: false });
  // Two windows later the old counts are gone.
  now += 120_000;
  for (let i = 0; i < 5; i++) expect(limiter.consume('k', minute).ok).toBe(true);
  // Other keys are independent; limit 0 means off.
  expect(limiter.consume('other', minute).ok).toBe(true);
  for (let i = 0; i < 100; i++) expect(limiter.consume('k', { ...minute, limit: 0 }).ok).toBe(true);
});

test('sliding window: the previous window still weighs in, then decays', () => {
  let now = 2_000 * 60_000 + 59_000; // last second of a window
  const limiter = new RateLimiter(() => now);
  for (let i = 0; i < 5; i++) limiter.consume('k', minute);
  now += 2_000; // 1s into the next window: previous 5 still weigh ~4.9
  expect(limiter.consume('k', minute).ok).toBe(false);
  now += 30_000; // halfway: 5 * 0.48 = 2.4 → two more fit
  expect(limiter.consume('k', minute).ok).toBe(true);
  expect(limiter.consume('k', minute).ok).toBe(true);
  expect(limiter.consume('k', minute).ok).toBe(false);
});

test('Retry-After is honest: waiting that long is enough, and one second less is not', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const random = mulberry32(seed);
    let now = 5_000 * 60_000 + Math.floor(random() * 60_000);
    const limiter = new RateLimiter(() => now);
    const rule = { limit: 1 + Math.floor(random() * 20), windowMs: 60_000 };
    let rejected: { ok: false; retryAfter: number } | undefined;
    for (let i = 0; i < 200 && !rejected; i++) {
      now += Math.floor(random() * 2_000);
      const decision = limiter.consume('k', rule);
      if (!decision.ok) rejected = decision;
    }
    if (!rejected) continue;
    expect(rejected.retryAfter).toBeGreaterThanOrEqual(1);
    expect(rejected.retryAfter).toBeLessThanOrEqual(120);
    const at = now;
    if (rejected.retryAfter > 1) {
      now = at + (rejected.retryAfter - 1) * 1000 - 1;
      expect(limiter.consume('k', rule).ok, `seed ${seed} early`).toBe(false);
    }
    now = at + rejected.retryAfter * 1000;
    expect(limiter.consume('k', rule).ok, `seed ${seed}`).toBe(true);
  }
});

test('memory stays bounded', () => {
  let now = 0;
  const limiter = new RateLimiter(() => now, 1_000);
  for (let i = 0; i < 5_000; i++) limiter.consume(`k${i}`, minute);
  now += 3 * 60_000;
  limiter.consume('fresh', minute);
  expect(
    (limiter as unknown as { buckets: Map<string, unknown> }).buckets.size,
  ).toBeLessThanOrEqual(1_001);
});

test('client address: X-Forwarded-For is only read through trusted proxy hops', () => {
  const defaults = trustedProxies('loopback,private');
  // Directly connected public client: its own header is ignored.
  expect(clientAddress('203.0.113.9', '1.2.3.4', defaults)).toBe('203.0.113.9');
  // Behind a same-host or Docker proxy: the proxy appended the real client last.
  expect(clientAddress('127.0.0.1', '198.51.100.7', defaults)).toBe('198.51.100.7');
  expect(clientAddress('::ffff:172.18.0.1', '198.51.100.7', defaults)).toBe('198.51.100.7');
  // A forged left part cannot win: walking stops at the first untrusted hop.
  expect(clientAddress('127.0.0.1', '6.6.6.6, 198.51.100.7', defaults)).toBe('198.51.100.7');
  // Proxy chain inside the private network.
  expect(clientAddress('10.0.0.2', '198.51.100.7, 10.0.0.5', defaults)).toBe('198.51.100.7');
  // Nothing forwarded: the peer itself.
  expect(clientAddress('::1', undefined, defaults)).toBe('::1');
  // Garbage entries are skipped.
  expect(clientAddress('127.0.0.1', 'not-an-ip, 198.51.100.7', defaults)).toBe('198.51.100.7');
  const none = trustedProxies('none');
  expect(clientAddress('127.0.0.1', '198.51.100.7', none)).toBe('127.0.0.1');
  const cidr = trustedProxies('203.0.113.0/24');
  expect(clientAddress('203.0.113.2', '198.51.100.7', cidr)).toBe('198.51.100.7');
  expect(clientAddress('10.0.0.2', '198.51.100.7', cidr)).toBe('10.0.0.2');
  expect(clientAddress(undefined, '198.51.100.7', defaults)).toBe('unknown');
  expect(() => trustedProxies('localhost')).toThrow('TRUSTED_PROXIES');
});

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
