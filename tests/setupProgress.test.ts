import { expect, test } from 'vitest';
import {
  connectionsEmptyGuide,
  setupProgress,
} from '../apps/web/src/features/onboarding/setupProgress.js';

const profile = {
  id: 'agent',
  toolIds: ['tool'],
  contentIds: [],
  skillVersionIds: [],
  artifactIds: [],
};

test('a saved or stopped connection does not count as ready', () => {
  expect(
    setupProgress({
      connections: [{ status: 'disconnected' }, { status: 'stopped' }],
      profiles: [],
      keys: [],
    }),
  ).toEqual([false, false, false]);
});

test('a profile must have an explicit grant before the guide suggests exporting its key', () => {
  expect(
    setupProgress({
      connections: [{ status: 'connected' }],
      profiles: [{ ...profile, toolIds: [] }],
      keys: [{ profileId: profile.id, revoked: false }],
    }),
  ).toEqual([true, false, false]);
});

test('revoked keys and keys belonging to other profiles do not complete setup', () => {
  expect(
    setupProgress({
      connections: [{ status: 'connected' }],
      profiles: [profile],
      keys: [
        { profileId: profile.id, revoked: true },
        { profileId: 'other', revoked: false },
      ],
    }),
  ).toEqual([true, true, false]);
  expect(
    setupProgress({
      connections: [],
      profiles: [profile],
      keys: [{ profileId: profile.id, revoked: false }],
    }),
  ).toEqual([false, true, true]);
});

test('prompt and resource grants support agents without tool grants', () => {
  expect(
    setupProgress({
      connections: [{ status: 'connected' }],
      profiles: [{ ...profile, toolIds: [], contentIds: ['resource'] }],
      keys: [{ profileId: profile.id, revoked: false }],
    }),
  ).toEqual([true, true, true]);
});

test('a connected shared connection completes the first setup step', () => {
  const base = { connections: [], profiles: [], keys: [] };
  expect(setupProgress({ ...base, shared: [{ status: 'pending' }] })[0]).toBe(false);
  expect(setupProgress({ ...base, shared: [{ status: 'connected' }] })[0]).toBe(true);
});

test('overview empty state depends on role and shared connections', () => {
  expect(connectionsEmptyGuide({ role: 'admin', own: 0, shared: 0 })).toBe('admin-first');
  expect(connectionsEmptyGuide({ role: undefined, own: 0, shared: 0 })).toBe('admin-first');
  expect(connectionsEmptyGuide({ role: 'member', own: 0, shared: 0 })).toBe('member-none');
  expect(connectionsEmptyGuide({ role: 'member', own: 0, shared: 2 })).toBe('none');
  expect(connectionsEmptyGuide({ role: 'admin', own: 1, shared: 0 })).toBe('none');
});
