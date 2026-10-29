import { eq } from 'drizzle-orm';
import { z } from 'zod';
import semver from 'semver';
import { updateChecks, type Database } from '@platform/db';
import type { NetworkService } from '../network/service.js';
import { adminUser } from '../users/userAccess.js';
import { AppError } from '../../shared/errors.js';
import type { BuildInfo } from './buildInfo.js';
import { queryReleases, ReleaseError, type ReleaseCache, type Release } from './releases.js';
import { UPDATE_INTERVAL_MS } from './packageService.js';
export function releaseState(build: BuildInfo, release: Release | null) {
  if (!release) return 'no_release';
  if (!build.release || !semver.valid(build.version)) return 'development';
  return semver.gt(release.tag_name, build.version) ? 'available' : 'up_to_date';
}
export class PlatformUpdateService {
  private pending?: Promise<unknown>;
  constructor(
    private readonly deps: {
      db: Database;
      network: NetworkService;
      build: BuildInfo;
      now: () => Date;
    },
  ) {}
  async adminStatus(actor: string) {
    await adminUser(this.deps.db, actor);
    return this.status();
  }
  async status() {
    const [row] = await this.deps.db
      .select()
      .from(updateChecks)
      .where(eq(updateChecks.id, 'platform'));
    const revision = (await this.deps.network.snapshot()).revision;
    const { cache: _cache, ...savedResult } = row?.result ?? {};
    const result = ['available', 'up_to_date', 'development', 'no_release'].includes(
      String(savedResult.state),
    )
      ? {
          ...savedResult,
          state: releaseState(this.deps.build, savedResult.release as Release | null),
        }
      : savedResult;
    return {
      build: this.deps.build,
      scheduled: row?.scheduled ?? false,
      nextCheckAt: row?.nextCheckAt,
      stale: Boolean(row && row.fingerprint !== String(revision)),
      result: row?.result ? result : null,
    };
  }
  async check(actor?: string) {
    if (actor) await adminUser(this.deps.db, actor);
    this.pending ??= this.perform().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  async schedule(actor: string, value: unknown) {
    await adminUser(this.deps.db, actor);
    const { scheduled } = z.object({ scheduled: z.boolean() }).strict().parse(value);
    const fingerprint = String((await this.deps.network.snapshot()).revision);
    const nextCheckAt = scheduled ? new Date(this.deps.now().getTime() + UPDATE_INTERVAL_MS) : null;
    await this.deps.db
      .insert(updateChecks)
      .values({ id: 'platform', fingerprint, scheduled, nextCheckAt })
      .onConflictDoUpdate({ target: updateChecks.id, set: { scheduled, nextCheckAt } });
    return this.status();
  }
  private async perform() {
    const fingerprint = String((await this.deps.network.snapshot()).revision);
    const [previous] = await this.deps.db
      .select()
      .from(updateChecks)
      .where(eq(updateChecks.id, 'platform'));
    let result: Record<string, unknown>;
    try {
      const previousCache =
        previous?.fingerprint === fingerprint
          ? (previous.result?.cache as ReleaseCache | undefined)
          : undefined;
      const { release, cache } = await queryReleases(this.deps.network.fetch, previousCache ?? {});
      result = {
        state: releaseState(this.deps.build, release),
        release,
        cache,
        checkedAt: this.deps.now().toISOString(),
      };
    } catch (error) {
      result = failedResult({ error, previous, fingerprint, now: this.deps.now() });
    }
    if (String((await this.deps.network.snapshot()).revision) !== fingerprint)
      throw new AppError('CHECK_SUPERSEDED', '网络配置已变化，请重新检查平台更新', 409);
    await this.deps.db
      .insert(updateChecks)
      .values({ id: 'platform', fingerprint, result })
      .onConflictDoUpdate({ target: updateChecks.id, set: { fingerprint, result } });
    return this.status();
  }
}

function failedResult({
  error,
  previous,
  fingerprint,
  now,
}: {
  error: unknown;
  previous?: { fingerprint: string; result: Record<string, unknown> | null };
  fingerprint: string;
  now: Date;
}) {
  return {
    state: error instanceof ReleaseError ? error.state : 'failed',
    error:
      error instanceof ReleaseError
        ? error.message
        : 'Release 查询失败，请检查网络、端点、凭证和响应格式',
    checkedAt: now.toISOString(),
    release: previous?.result?.release,
    cache: previous?.fingerprint === fingerprint ? previous.result?.cache : undefined,
    previousStale: true,
  };
}
