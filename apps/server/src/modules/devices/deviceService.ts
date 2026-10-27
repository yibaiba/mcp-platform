import { and, eq, gt } from 'drizzle-orm';
import { devices, pairings, type Database } from '@platform/db';
import { pairingLifetimeMs, type DeviceResponse } from '@platform/contracts';
import { digest, secretToken } from '../../shared/crypto.js';
import { AppError, requireValue } from '../../shared/errors.js';
import type { DeviceBroker } from './deviceBroker.js';
export class DeviceService {
  constructor(
    private readonly db: Database,
    private readonly broker: DeviceBroker,
  ) {}
  async createPairing(ownerId: string, name: string) {
    const code = secretToken();
    const expiresAt = new Date(Date.now() + pairingLifetimeMs);
    await this.db.insert(pairings).values({ ownerId, name, codeHash: digest(code), expiresAt });
    return { code, expiresAt };
  }
  async pair(code: string) {
    return this.db.transaction(async (tx) => {
      const [pairing] = await tx
        .delete(pairings)
        .where(and(eq(pairings.codeHash, digest(code)), gt(pairings.expiresAt, new Date())))
        .returning();
      if (!pairing) throw new AppError('PAIRING_INVALID', '配对码无效、已使用或已过期', 401);
      const token = secretToken();
      const [device] = await tx
        .insert(devices)
        .values({ ownerId: pairing.ownerId, name: pairing.name, tokenHash: digest(token) })
        .returning();
      return { deviceId: requireValue(device).id, token };
    });
  }
  async authenticate(token: string) {
    const [device] = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.tokenHash, digest(token)), eq(devices.revoked, false)));
    if (!device) throw new AppError('DEVICE_UNAUTHORIZED', '设备凭证无效或已撤销', 401);
    return device;
  }
  async list(ownerId: string) {
    const rows = await this.db.select().from(devices).where(eq(devices.ownerId, ownerId));
    return rows.map(({ tokenHash: _tokenHash, ...row }) => ({
      ...row,
      online: this.broker.online(row.id),
    }));
  }
  async owned(ownerId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.id, id), eq(devices.ownerId, ownerId), eq(devices.revoked, false)));
    return requireValue(row, '设备不存在或已撤销');
  }
  async revoke(ownerId: string, id: string) {
    await this.owned(ownerId, id);
    await this.db.update(devices).set({ revoked: true }).where(eq(devices.id, id));
    this.broker.disconnect(id);
  }
}
export async function reportDevice(db: Database, id: string, message: DeviceResponse) {
  if (message.type === 'result' || message.type === 'notification') return;
  const fields =
    message.type === 'hello'
      ? { os: message.os, version: message.version, hostname: message.hostname }
      : { services: message.services };
  await db
    .update(devices)
    .set({ ...fields, lastSeen: new Date() })
    .where(and(eq(devices.id, id), eq(devices.revoked, false)));
}
