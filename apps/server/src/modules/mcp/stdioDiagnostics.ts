import { StringDecoder } from 'node:string_decoder';
import type { Stream } from 'node:stream';
import { errorMessage } from '../../shared/errors.js';

// Diagnostics retain a 32 KiB tail; overlong lines are explicitly omitted.
export const STDERR_TAIL_BYTES = 32 * 1024;
const omittedLine = '[stderr 单行超过 32 KiB，内容已省略]';

export function observeStdioStderr(
  stream: Stream,
  effects: {
    redact: (text: string) => string;
    log: (text: string) => void;
  },
) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let omitted = false;
  let tail = '';
  let truncated = false;
  function line() {
    const text = omitted ? omittedLine : effects.redact(pending.replace(/\r$/, ''));
    pending = '';
    omitted = false;
    if (!text) return;
    effects.log(text);
    const buffer = Buffer.from(`${tail}${text}\n`);
    truncated ||= buffer.length > STDERR_TAIL_BYTES;
    tail = buffer.subarray(-STDERR_TAIL_BYTES).toString('utf8');
  }
  function consume(text: string) {
    const parts = text.split('\n');
    parts.forEach((part, index) => {
      if (!omitted) {
        pending += part;
        if (Buffer.byteLength(pending) > STDERR_TAIL_BYTES) {
          pending = '';
          omitted = true;
        }
      }
      if (index < parts.length - 1) line();
    });
  }
  stream.on('data', (chunk: Buffer) => consume(decoder.write(chunk)));
  stream.on('end', () => {
    consume(decoder.end());
    line();
  });
  return (error: unknown) => {
    const text = `${tail}${omitted ? omittedLine : effects.redact(pending)}`.trim();
    const prefix = truncated ? '[仅显示最近 32 KiB stderr]\n' : '';
    return new Error(`${errorMessage(error)}${text ? `\n上游 stderr：\n${prefix}${text}` : ''}`, {
      cause: error,
    });
  };
}
