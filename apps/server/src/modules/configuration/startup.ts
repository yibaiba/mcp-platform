import type { ManifestService } from './manifestService.js';
import { AppError } from '../../shared/errors.js';
export async function applyStartupManifest(deps: {
  file?: string;
  ownerEmail?: string;
  read: (path: string) => Promise<string>;
  owner: (email: string) => Promise<string | undefined>;
  manifests: ManifestService;
}) {
  if (!deps.file) return;
  if (!deps.ownerEmail) throw new AppError('CONFIG_OWNER_REQUIRED', '启动模板必须明确指定已有账号');
  const ownerId = await deps.owner(deps.ownerEmail);
  if (!ownerId) throw new AppError('CONFIG_OWNER_REQUIRED', '启动模板指定的账号不存在或已停用');
  return deps.manifests.apply(ownerId, JSON.parse(await deps.read(deps.file)) as unknown);
}
