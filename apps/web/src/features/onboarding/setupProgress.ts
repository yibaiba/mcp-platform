import type { Connection, Profile } from '../../lib/api.js';

export type AccessKey = { profileId: string; revoked: boolean };
export function setupProgress(input: {
  connections: readonly Pick<Connection, 'status'>[];
  profiles: readonly Pick<
    Profile,
    'id' | 'toolIds' | 'contentIds' | 'skillVersionIds' | 'artifactIds'
  >[];
  keys: readonly AccessKey[];
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
    input.connections.some((connection) => connection.status === 'connected'),
    granted.size > 0,
    input.keys.some((key) => !key.revoked && granted.has(key.profileId)),
  ];
}
