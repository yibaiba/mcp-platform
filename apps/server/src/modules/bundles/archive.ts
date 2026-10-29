import { unzipSync } from 'fflate';
import { mcpbManifest } from '@platform/contracts';
import { safeRelativePath, filesDigest } from '../skills/packageService.js';
import { AppError } from '../../shared/errors.js';
export function unpackBundle(data: Uint8Array) {
  try {
    return parseArchive(data);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('MCPB_INVALID', 'ZIP 或 manifest.json 无效；请检查文件完整性和清单格式');
  }
}
function parseArchive(data: Uint8Array) {
  const executable = validateDirectory(data);
  const archive = unzipSync(data);
  const files: Record<string, string> = {};
  for (const [name, value] of Object.entries(archive)) {
    if (name.endsWith('/')) continue;
    files[safeRelativePath(name)] = Buffer.from(value).toString('base64');
  }
  if (!files['manifest.json'])
    throw new AppError('MCPB_MANIFEST', 'MCPB 根目录必须包含 manifest.json');
  const manifest = mcpbManifest.parse(
    JSON.parse(Buffer.from(files['manifest.json'], 'base64').toString('utf8')),
  );
  safeRelativePath(manifest.server.entry_point);
  if (!files[manifest.server.entry_point]) throw new AppError('MCPB_ENTRY', '清单入口文件不存在');
  return { files, manifest, executable, digest: filesDigest(files) };
}
function validateDirectory(data: Uint8Array) {
  const b = Buffer.from(data),
    names = new Set<string>(),
    executable: string[] = [];
  let end = b.length - 22;
  while (end >= Math.max(0, b.length - 65557) && b.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || end < Math.max(0, b.length - 65557))
    throw new AppError('MCPB_ZIP', '无效 ZIP 目录');
  const count = b.readUInt16LE(end + 10);
  let offset = b.readUInt32LE(end + 16);
  if (count === 65535 || offset === 0xffffffff)
    throw new AppError('MCPB_ZIP', '首版不支持 ZIP64 扩展包');
  for (let i = 0; i < count; i++) {
    if (offset + 46 > b.length || b.readUInt32LE(offset) !== 0x02014b50)
      throw new AppError('MCPB_ZIP', '损坏的 ZIP 文件索引');
    const length = b.readUInt16LE(offset + 28),
      mode = b.readUInt32LE(offset + 38) >>> 16;
    const name = b.subarray(offset + 46, offset + 46 + length).toString('utf8');
    const path = safeRelativePath(name.endsWith('/') ? name.slice(0, -1) : name);
    if (names.has(path) || ((mode & 0xf000) !== 0 && ![0x8000, 0x4000].includes(mode & 0xf000)))
      throw new AppError('MCPB_PATH', '扩展包包含重复路径、符号链接或特殊文件');
    names.add(path);
    if ((mode & 0o111) !== 0 && !name.endsWith('/')) executable.push(path);
    offset += 46 + length + b.readUInt16LE(offset + 30) + b.readUInt16LE(offset + 32);
  }
  return executable;
}
