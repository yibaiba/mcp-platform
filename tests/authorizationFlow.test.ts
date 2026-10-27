import { expect, test, vi } from 'vitest';
import { authorizeConnection } from '../apps/web/src/features/connections/authorizationFlow.js';

test('authorization opens the provider once and waits for its callback before discovery', async () => {
  const navigate = vi.fn();
  const request = vi
    .fn()
    .mockResolvedValue({ status: 'REDIRECT', authorizationUrl: 'https://example.test/authorize' });
  await authorizeConnection({ endpoint: '/connections/test/oauth', request, navigate });
  expect(navigate).toHaveBeenCalledExactlyOnceWith('https://example.test/authorize');
  expect(request).toHaveBeenCalledExactlyOnceWith('/connections/test/oauth/start', {
    method: 'POST',
  });
});

test.each([{ status: 'AUTHORIZED' }, { details: { authenticated: true } }])(
  'already authorized platform and Pi connections discover without another sign-in',
  async (authorized) => {
    const navigate = vi.fn();
    const request = vi.fn().mockResolvedValueOnce(authorized).mockResolvedValueOnce({ tools: [] });
    const result = await authorizeConnection({
      endpoint: '/connections/test/oauth',
      request,
      navigate,
    });
    expect(result).toMatchObject({ status: 'AUTHORIZED', connected: { tools: [] } });
    expect(navigate).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/connections/test/oauth/start',
      '/connections/test/oauth/discover',
    ]);
  },
);

test('invalid authorization results and request failures stay visible and never retry', async () => {
  const navigate = vi.fn();
  const request = vi
    .fn()
    .mockResolvedValue({ status: 'REDIRECT', authorizationUrl: 'javascript:alert(1)' });
  await expect(authorizeConnection({ endpoint: '/oauth', request, navigate })).rejects.toThrow(
    '有效授权地址',
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect(navigate).not.toHaveBeenCalled();
  request.mockReset().mockRejectedValue(new Error('vendor unavailable'));
  await expect(authorizeConnection({ endpoint: '/oauth', request, navigate })).rejects.toThrow(
    'vendor unavailable',
  );
  expect(request).toHaveBeenCalledTimes(1);
});
