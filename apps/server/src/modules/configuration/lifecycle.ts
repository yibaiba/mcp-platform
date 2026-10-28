import type { ManifestService } from './manifestService.js';
import type { DiagnosticLogger } from '../activity/systemLogger.js';
const RECONCILE_INTERVAL_MS = 30_000;
export function startManifestReconciliation(deps: {
  manifests: ManifestService;
  owners: () => Promise<readonly string[]>;
  logger: DiagnosticLogger;
}) {
  let running: Promise<void> | undefined;
  const refresh = () => {
    if (running) return;
    running = deps
      .owners()
      .then(async (owners) => {
        for (const ownerId of owners) await deps.manifests.refresh(ownerId);
      })
      .catch(() => deps.logger.report('MANIFEST_RECONCILIATION_FAILED'))
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(refresh, RECONCILE_INTERVAL_MS);
  timer.unref();
  refresh();
  return async () => {
    clearInterval(timer);
    await running;
    await deps.manifests.close();
  };
}
