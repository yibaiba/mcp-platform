import { appendFileSync } from 'node:fs';
import { readMetadata } from './connector-packaging/metadata.mjs';

const tag = process.env.RELEASE_TAG;
const metadata = readMetadata(tag ? tag.replace(/^v/, '') : undefined);
const outputs = {
  version: metadata.version,
};
appendFileSync(
  process.env.GITHUB_OUTPUT,
  Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join(''),
);
console.log(`Release version: ${metadata.version}`);
