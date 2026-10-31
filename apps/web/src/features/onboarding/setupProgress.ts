import type { Connection, Profile } from '../../lib/api.js';

export type AccessKey = { profileId: string; revoked: boolean };
export function setupProgress(input: {
  connections: readonly Pick<Connection, 'status'>[];
  profiles: readonly Pick<
    Profile,
    'id' | 'toolIds' | 'contentIds' | 'skillVersionIds' | 'artifactIds'
  >[];
  keys: readonly AccessKey[];
  /** Connections other accounts shared with this user; a connected one also completes step 1. */
  shared?: readonly { status: string }[];
}) {
  const granted = new Set(
    input.profiles
      .filter((profile) =>
        [profile.toolIds, profile.contentIds, profile.skillVersionIds, profile.artifactIds].some(
          (ids) => ids.length,
        ),
      )
      .map((profile) => profile.id),
  );
  return [
    [...input.connections, ...(input.shared ?? [])].some(
      (connection) => connection.status === 'connected',
    ),
    granted.size > 0,
    input.keys.some((key) => !key.revoked && granted.has(key.profileId)),
  ];
}

/** Connections an Agent cannot use right now: upstream in error or its device offline. */
export function brokenConnections<T extends Pick<Connection, 'status' | 'deviceOffline'>>(
  connections: readonly T[],
) {
  return connections.filter(
    (connection) =>
      connection.status !== 'stopped' &&
      (connection.status === 'error' || Boolean(connection.deviceOffline)),
  );
}

/** Setup only counts as done while every saved connection is usable, not just configured. */
export function setupStatus<C extends Pick<Connection, 'status' | 'deviceOffline'>>(
  input: Omit<Parameters<typeof setupProgress>[0], 'connections'> & { connections: readonly C[] },
) {
  const steps = setupProgress(input);
  const broken = brokenConnections(input.connections);
  return { steps, broken, complete: steps.every(Boolean) && broken.length === 0 };
}

/**
 * What the overview's connection card should offer when the user has no rows to show.
 * Members usually get connections shared by an admin, so "add your first connection" is the
 * wrong first step for them; admins (or an unknown role while /me loads) keep the old prompt.
 */
export function connectionsEmptyGuide(input: {
  role?: 'admin' | 'member';
  own: number;
  shared: number;
}): 'none' | 'admin-first' | 'member-none' {
  if (input.own || input.shared) return 'none';
  return input.role === 'member' ? 'member-none' : 'admin-first';
}
