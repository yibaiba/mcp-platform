import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { connectionInput, connectorPresets } from '../packages/contracts/src/index.js';
import { presetConnection } from '../apps/web/src/features/connections/presetConnection.js';
import { authorizationResult } from '../apps/web/src/features/connections/authorizationResult.js';
import { harness } from './harness.js';

const github = connectorPresets.find((preset) => preset.id === 'github')!;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h?.close();
});

test('official connector presets produce valid remote configurations without embedded credentials', () => {
  for (const preset of connectorPresets) {
    const authentication = preset.authentication[0]!;
    const input = presetConnection({
      preset,
      name: preset.name,
      authentication,
      token: authentication === 'bearer' ? randomBytes(16).toString('hex') : undefined,
    });
    expect(connectionInput.parse(input).url).toBe(preset.url);
    expect(input).toMatchObject({ adapter: 'direct', transport: 'http', mode: 'existing' });
    expect(new URL(input.url!).protocol).toBe('https:');
    expect(new URL(preset.documentationUrl).protocol).toBe('https:');
    expect(preset).not.toHaveProperty('token');
    expect(preset).not.toHaveProperty('clientSecret');
  }
});

test('authentication changes exclude credentials belonging to the previous method', () => {
  const credentials = {
    token: randomBytes(16).toString('hex'),
    clientId: randomBytes(8).toString('hex'),
    clientSecret: randomBytes(16).toString('hex'),
  };
  const base = { preset: github, name: github.name, ...credentials };
  const oauth = presetConnection({ ...base, authentication: 'oauth' });
  expect(oauth.headers).toEqual({});
  expect(oauth.credentialHeaders).toEqual([]);
  expect(JSON.stringify(oauth)).not.toContain(credentials.token);
  expect(oauth.oauth).toMatchObject({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  });
  const bearer = presetConnection({ ...base, authentication: 'bearer' });
  expect(bearer.headers).toEqual({ Authorization: `Bearer ${credentials.token}` });
  expect(bearer.credentialHeaders).toEqual(['Authorization']);
  expect(bearer.oauth).toBeUndefined();
  expect(JSON.stringify(bearer)).not.toContain(credentials.clientSecret);
});

test('missing credentials, unsupported authentication and header injection expose explicit errors', () => {
  const base = { preset: github, name: github.name };
  expect(() => presetConnection({ ...base, authentication: 'bearer', token: ' ' })).toThrow(
    'Token',
  );
  expect(() =>
    presetConnection({ ...base, authentication: 'bearer', token: 'a\r\nX-Key: b' }),
  ).toThrow('换行');
  expect(() =>
    presetConnection({ ...base, authentication: 'oauth', clientId: 'registered' }),
  ).toThrow('Client Secret');
  expect(() => presetConnection({ ...base, authentication: 'none' })).toThrow('不支持');
});

test('Pi preset selection preserves registered OAuth settings and parses the Pi authorization response', () => {
  const input = presetConnection({
    preset: github,
    name: github.name,
    adapter: 'pi',
    authentication: 'oauth',
    clientId: 'registered-test',
    clientSecret: randomBytes(16).toString('hex'),
  });
  expect(input.adapter).toBe('pi');
  expect(input.oauth?.tokenEndpointAuthMethod).toBe('client_secret_post');
  const callback = 'http://127.0.0.1:3118/callback';
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('redirect_uri', callback);
  const parsed = authorizationResult({ content: [], details: { authorizationUrl: url.href } });
  expect(parsed.url?.href).toBe(url.href);
  expect(parsed.redirectUrl).toBe(callback);
  expect(authorizationResult({ authorizationUrl: url.href, redirectUrl: callback })).toEqual(
    parsed,
  );
});

test('authorization responses cannot create executable or credential-bearing links', () => {
  for (const authorizationUrl of [
    'javascript:alert(1)',
    'data:text/html,test',
    'https://user:secret@example.test',
    'invalid',
  ]) {
    expect(authorizationResult({ authorizationUrl }).url).toBeUndefined();
    expect(authorizationResult({ details: { authorizationUrl } }).url).toBeUndefined();
  }
  expect(authorizationResult(null).url).toBeUndefined();
});

test.each(['bearer', 'oauth'] as const)(
  '%s preset credentials persist encrypted and stay out of management responses',
  async (authentication) => {
    const account = await h.signup();
    const secret = randomBytes(24).toString('hex');
    const input = presetConnection({
      preset: github,
      name: github.name,
      authentication,
      token: secret,
      clientId: randomBytes(8).toString('hex'),
      clientSecret: secret,
    });
    const response = await account.request('/connections', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    expect(JSON.stringify(created)).not.toContain(secret);
    const stored = await h.services.connections.owned(account.ownerId, created.id);
    expect(JSON.stringify(stored)).not.toContain(secret);
    const context = await h.services.connections.context(account.ownerId, created.id);
    expect(
      authentication === 'bearer'
        ? context.config.headers.Authorization
        : context.config.oauth?.clientSecret,
    ).toBe(authentication === 'bearer' ? `Bearer ${secret}` : secret);
    const listed = await account.request('/connections');
    expect(listed.status).toBe(200);
    expect(await listed.text()).not.toContain(secret);
    // Saving a preset does not contact the vendor or create an authorization session.
    expect((await h.services.upstreamOAuth.status(context)).authorized).toBe(false);
  },
);
