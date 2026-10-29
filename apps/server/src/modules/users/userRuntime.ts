import { connections, devices, type Database } from '@platform/db';
import { and, eq } from 'drizzle-orm';
import type { Services } from '../../services.js';

export async function disableUserRuntime(input: {
  db: Database;
  services: Services;
  ownerId: string;
}) {
  const { db, services: s, ownerId } = input;
  await s.cliAuth.revokeOwner(ownerId);
  s.invocations.revoke({ ownerId });
  const [ownedConnections, ownedDevices] = await Promise.all([
    db.select({ id: connections.id }).from(connections).where(eq(connections.ownerId, ownerId)),
    db.select({ id: devices.id }).from(devices).where(eq(devices.ownerId, ownerId)),
  ]);
  const outcomes = await Promise.allSettled([
    s.gateway.revokeOwner(ownerId),
    s.pi.revokeOwner(ownerId),
    s.access.changed(),
    s.connections.closeOwnerSessions(ownerId),
    ...ownedConnections.map(({ id }) => s.connections.close(ownerId, id)),
  ]);
  for (const { id } of ownedDevices) s.broker.disconnect(id);
  await db
    .update(connections)
    .set({ status: 'disconnected' })
    .where(and(eq(connections.ownerId, ownerId), eq(connections.status, 'connected')));
  const failures = outcomes
    .filter((outcome) => outcome.status === 'rejected')
    .map((outcome) => outcome.reason);
  if (failures.length) throw new AggregateError(failures, '账号已停用；部分运行时清理失败');
}
