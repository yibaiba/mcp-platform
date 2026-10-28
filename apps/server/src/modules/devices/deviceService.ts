import { activeUser } from '../users/userAccess.js';
import { randomUUID } from 'node:crypto';
import { DeviceSerial, verifyDeviceMac } from './deviceAuthentication.js';
import {
  deviceAuthBytes,
  type DeviceAuthChallenge,
  type DeviceAuthResponse,
} from '@platform/contracts';
import type { Vault } from '../../shared/crypto.js';
import { and, eq, gt, sql } from 'drizzle-orm';
import { devices, pairings, type Database } from '@platform/db';
import { pairingLifetimeMs, type DeviceResponse } from '@platform/contracts';
import { digest, secretToken } from '../../shared/crypto.js';
import { AppError, requireValue } from '../../shared/errors.js';
import type { DeviceBroker } from './deviceBroker.js';
export class DeviceService {
  private readonly serial = new DeviceSerial();
  constructor(
    private readonly deps: {
      db: Database;
      broker: DeviceBroker;
      vault: Vault;
      platformOrigin: string;
    },
  ) {}
  private get db() {
    return this.deps.db;
  }
  private get broker() {
    return this.deps.broker;
  }
  private scope(device: { ownerId: string; id: string; credentialVersion: number }) {
    return JSON.stringify(['device-auth', device.ownerId, device.id, device.credentialVersion]);
  }
  async createPairing(ownerId: string, name: string) {
    const code = secretToken();
    const expiresAt = new Date(Date.now() + pairingLifetimeMs);
    await this.db.insert(pairings).values({ ownerId, name, codeHash: digest(code), expiresAt });
    return { code, expiresAt };
  }
  async createRePairing(ownerId: string, id: string) {
    return this.serial.run(id, async () => {
      const code = secretToken();
      const expiresAt = new Date(Date.now() + pairingLifetimeMs);
      await this.db.transaction(async (tx) => {
        const [device] = await tx
          .select()
          .from(devices)
          .where(and(eq(devices.id, id), eq(devices.ownerId, ownerId), eq(devices.revoked, false)))
          .for('update');
        if (!device) throw new AppError('DEVICE_UNAVAILABLE', '设备不存在或已撤销', 404);
        await tx
          .update(devices)
          .set({ secretEncrypted: null, credentialVersion: device.credentialVersion + 1 })
          .where(eq(devices.id, id));
        await tx.delete(pairings).where(eq(pairings.deviceId, id));
        await tx
          .insert(pairings)
          .values({ ownerId, name: device.name, deviceId: id, codeHash: digest(code), expiresAt });
      });
      this.broker.disconnect(id);
      return { code, expiresAt };
    });
  }
  async pair(code: string, deviceId?: string) {
    // Re-pair callers must identify the target; no identity is inferred from an untrusted code.
    return this.serial.run(deviceId ?? `pair:${digest(code)}`, () =>
      this.db.transaction(async (tx) => {
        const [pairing] = await tx
          .delete(pairings)
          .where(and(eq(pairings.codeHash, digest(code)), gt(pairings.expiresAt, new Date())))
          .returning();
        if (!pairing || (pairing.deviceId ?? undefined) !== deviceId)
          throw new AppError('PAIRING_INVALID', '配对码无效、已使用或已过期，或设备不匹配', 401);
        await activeUser(tx, pairing.ownerId);
        const deviceSecret = secretToken();
        if (deviceId) {
          const [device] = await tx
            .select()
            .from(devices)
            .where(
              and(
                eq(devices.id, deviceId),
                eq(devices.ownerId, pairing.ownerId),
                eq(devices.revoked, false),
              ),
            )
            .for('update');
          if (!device) throw new AppError('PAIRING_INVALID', '配对码无效、已使用或已过期', 401);
          await tx
            .update(devices)
            .set({ secretEncrypted: this.deps.vault.seal(deviceSecret, this.scope(device)) })
            .where(eq(devices.id, deviceId));
          return { deviceId, deviceSecret, credentialVersion: device.credentialVersion };
        }
        const device = { id: randomUUID(), ownerId: pairing.ownerId, credentialVersion: 1 };
        await tx.insert(devices).values({
          ...device,
          name: pairing.name,
          secretEncrypted: this.deps.vault.seal(deviceSecret, this.scope(device)),
        });
        return { deviceId: device.id, deviceSecret, credentialVersion: device.credentialVersion };
      }),
    );
  }
  async authenticate(input: {
    challenge: DeviceAuthChallenge;
    response: DeviceAuthResponse;
    register: () => void;
  }) {
    return this.serial.run(input.response.deviceId, async () => {
      const [device] = await this.db
        .select()
        .from(devices)
        .where(eq(devices.id, input.response.deviceId));
      if (
        !device ||
        device.revoked ||
        !device.secretEncrypted ||
        device.credentialVersion !== input.response.credentialVersion ||
        Date.parse(input.challenge.expiresAt) <= Date.now()
      )
        throw new AppError('DEVICE_UNAUTHORIZED', '设备认证失败', 401);
      await activeUser(this.db, device.ownerId);
      const secret = deviceAuthBytes.parse(
        this.deps.vault.open(device.secretEncrypted, this.scope(device)),
      );
      if (!verifyDeviceMac({ secret, platformOrigin: this.deps.platformOrigin, ...input }))
        throw new AppError('DEVICE_UNAUTHORIZED', '设备认证失败', 401);
      input.register();
    });
  }
  async list(ownerId: string) {
    const rows = await this.db
      .select({
        id: devices.id,
        name: devices.name,
        revoked: devices.revoked,
        os: devices.os,
        hostname: devices.hostname,
        version: devices.version,
        lastSeen: devices.lastSeen,
        services: devices.services,
        createdAt: devices.createdAt,
        credentialVersion: devices.credentialVersion,
        pairingRequired: sql<boolean>`${devices.secretEncrypted} is null`,
      })
      .from(devices)
      .where(eq(devices.ownerId, ownerId));
    return rows.map((row) => ({ ...row, online: this.broker.online(row.id) }));
  }
  async owned(ownerId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.id, id), eq(devices.ownerId, ownerId), eq(devices.revoked, false)));
    return requireValue(row, '设备不存在或已撤销');
  }
  async revoke(ownerId: string, id: string) {
    await this.serial.run(id, async () => {
      await this.db.transaction(async (tx) => {
        const [device] = await tx
          .update(devices)
          .set({ revoked: true, secretEncrypted: null })
          .where(and(eq(devices.id, id), eq(devices.ownerId, ownerId), eq(devices.revoked, false)))
          .returning();
        requireValue(device, '设备不存在或已撤销');
        await tx.delete(pairings).where(eq(pairings.deviceId, id));
      });
      this.broker.disconnect(id);
    });
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
