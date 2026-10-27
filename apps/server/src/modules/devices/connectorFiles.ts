import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { connectorTargets } from '@platform/contracts';
import { AppError } from '../../shared/errors.js';

type ConnectorFile = { kind: 'download' | 'installer'; name: string };
export interface ConnectorFiles {
  open(file: ConnectorFile): Promise<{ body: ReadableStream<Uint8Array>; size: number }>;
}
const downloads = new Set<string>([
  ...connectorTargets.map((target) => target.filename),
  'SHA256SUMS',
]);
const installers = new Set(['install.sh', 'install.ps1']);

export function validateConnectorFile(file: ConnectorFile) {
  const allowed = file.kind === 'download' ? downloads : installers;
  if (!allowed.has(file.name)) throw new AppError('NOT_FOUND', '连接器文件不存在', 404);
}

export class DiskConnectorFiles implements ConnectorFiles {
  constructor(private readonly directories: { downloads: string; installers: string }) {}
  async open(file: ConnectorFile) {
    validateConnectorFile(file);
    const directory =
      file.kind === 'download' ? this.directories.downloads : this.directories.installers;
    try {
      const path = join(directory, file.name);
      await stat(path);
      const blob = await openAsBlob(path);
      return { body: blob.stream(), size: blob.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new AppError(
          'CONNECTOR_NOT_BUILT',
          '平台尚未构建连接器。请管理员运行 pnpm connector:build，或更新包含连接器的部署镜像。',
          503,
        );
      throw error;
    }
  }
}
