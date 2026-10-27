import { currentExecution } from '../mcp/executionContext.js';
import type { AccessService } from '../permissions/accessService.js';
import { streamFinally } from '../mcp/gatewayStream.js';
import { randomUUID } from 'node:crypto';
import { and, eq, gt, desc, inArray } from 'drizzle-orm';
import { artifacts, transfers, type Database } from '@platform/db';
import { z } from 'zod';
import { digest, secretToken } from '../../shared/crypto.js';
import { AppError, requireValue, errorMessage } from '../../shared/errors.js';
import type { DeviceBroker } from '../devices/deviceBroker.js';
import type { DeviceService } from '../devices/deviceService.js';
import type { FileStore } from './fileStore.js';
import { captureOutputScope, grantOutput, type OutputScope } from '../permissions/outputGrant.js';
export class ArtifactService {
  constructor(
    private readonly deps: {
      db: Database;
      files: FileStore;
      broker: DeviceBroker;
      devices: DeviceService;
      publicUrl: string;
      access: AccessService;
      changed: (profileId: string) => Promise<void>;
    },
  ) {}
  list(ownerId: string) {
    return this.deps.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.ownerId, ownerId))
      .orderBy(desc(artifacts.createdAt));
  }
  async listSelected(ownerId: string, ids: readonly string[]) {
    if (!ids.length) return [];
    return this.deps.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.ownerId, ownerId), inArray(artifacts.id, [...ids])))
      .orderBy(desc(artifacts.createdAt));
  }
  async upload(
    ownerId: string,
    input: { name: string; sha256: string; body: ReadableStream<Uint8Array> | null },
  ) {
    const name = z.string().min(1).parse(input.name);
    const sha256 = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(input.sha256);
    if (!input.body) throw new AppError('BODY_REQUIRED', '缺少文件流');
    return this.store(ownerId, { ...input, name, sha256 });
  }
  async store(
    ownerId: string,
    input: {
      name: string;
      body: ReadableStream<Uint8Array> | null;
      sha256?: string;
      outputScope?: OutputScope;
    },
  ) {
    if (!input.body) throw new AppError('BODY_REQUIRED', '缺少文件流');
    const id = randomUUID();
    const stored = await this.deps.files.write({ id, sha256: input.sha256, body: input.body });
    try {
      return await this.deps.db.transaction(async (tx) => {
        if (input.outputScope)
          await grantOutput(
            { tx, access: this.deps.access },
            { scope: input.outputScope, artifactId: id },
          );
        const [row] = await tx
          .insert(artifacts)
          .values({
            id,
            ownerId,
            name: input.name,
            ...stored,
            taskId: currentExecution()?.taskId,
            profileId: currentExecution()?.profileId,
          })
          .returning();
        return requireValue(row);
      });
    } catch (error) {
      await this.deps.files.remove(id);
      throw error;
    }
  }
  async resultWriter(ownerId: string, connectionId: string) {
    const outputScope = await captureOutputScope(this.deps.access, { ownerId, connectionId });
    return async (input: { name: string; body: ReadableStream<Uint8Array> | null }) => {
      const row = await this.store(ownerId, { ...input, outputScope });
      if (outputScope) await this.deps.changed(outputScope.profileId);
      return row;
    };
  }
  async blob(ownerId: string, id: string) {
    const [row] = await this.deps.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.id, id), eq(artifacts.ownerId, ownerId)));
    requireValue(row);
    return this.deps.files.blob(id);
  }
  async download(ownerId: string, id: string) {
    const [row] = await this.deps.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.id, id), eq(artifacts.ownerId, ownerId)));
    const artifact = requireValue(row);
    const abort = new AbortController();
    const profileId = currentExecution()?.profileId;
    if (profileId) await this.deps.access.assert({ ownerId, profileId }, 'artifactIds', id);
    const release = profileId
      ? await this.deps.access.monitor({
          access: { ownerId, profileId },
          kind: 'artifactIds',
          id,
          cancel: () => abort.abort(new AppError('GRANT_REVOKED', '下载授权已失效', 403)),
        })
      : () => {};
    const response = new Response(
      this.deps.files.read(id).pipeThrough(new TransformStream(), { signal: abort.signal }),
      {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(artifact.size),
          'X-Content-SHA256': artifact.sha256,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
        },
      },
    );
    return streamFinally(response, async () => release());
  }
  async transfer(
    ownerId: string,
    input: {
      deviceId: string;
      artifactId?: string;
      direction: 'send' | 'receive';
      root: string;
      path: string;
      signal?: AbortSignal;
    },
  ) {
    await this.deps.devices.owned(ownerId, input.deviceId);
    if (input.direction === 'receive') {
      const [row] = await this.deps.db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.id, input.artifactId!), eq(artifacts.ownerId, ownerId)));
      requireValue(row);
    }
    const token = secretToken();
    const [row] = await this.deps.db
      .insert(transfers)
      .values({
        ownerId,
        deviceId: input.deviceId,
        artifactId: input.artifactId,
        direction: input.direction,
        tokenHash: digest(token),
        expiresAt: new Date(Date.now() + 10 * 60_000),
        status: 'pending',
      })
      .returning();
    const id = requireValue(row).id;
    try {
      const result = await this.deps.broker.request(input.deviceId, {
        method: `artifact.${input.direction}`,
        params: {
          url: `${this.deps.publicUrl}/api/v1/transfers/${id}/content`,
          token,
          root: input.root,
          path: input.path,
        },
        signal: input.signal,
      });
      await this.deps.db.update(transfers).set({ status: 'completed' }).where(eq(transfers.id, id));
      return { id, result };
    } catch (error) {
      await this.deps.db
        .update(transfers)
        .set({ status: 'failed', error: errorMessage(error) })
        .where(eq(transfers.id, id));
      throw error;
    }
  }
  async claim(id: string, token: string, direction: string) {
    const [row] = await this.deps.db
      .update(transfers)
      .set({ status: 'streaming' })
      .where(
        and(
          eq(transfers.id, id),
          eq(transfers.tokenHash, digest(token)),
          eq(transfers.direction, direction),
          eq(transfers.status, 'pending'),
          gt(transfers.expiresAt, new Date()),
        ),
      )
      .returning();
    const transfer = requireValue(row, '传输凭证无效、已使用或已过期');
    await this.deps.devices.owned(transfer.ownerId, transfer.deviceId);
    return transfer;
  }
  async attach(id: string, artifactId: string) {
    await this.deps.db.update(transfers).set({ artifactId }).where(eq(transfers.id, id));
  }
}
