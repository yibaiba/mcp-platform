import { readFileSync } from 'node:fs';

export function readMetadata(version = process.env.CONNECTOR_VERSION) {
  const metadata = JSON.parse(
    readFileSync(new URL('../../connector/packaging/metadata.json', import.meta.url), 'utf8'),
  );
  const resolved = version || metadata.version;
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(
      resolved,
    )
  ) {
    throw new Error(`Unsupported release version: ${resolved}. Use X.Y.Z or X.Y.Z-prerelease.`);
  }
  return { ...metadata, version: resolved, numericVersion: resolved.split('-')[0] };
}
