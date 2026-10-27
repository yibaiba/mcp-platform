import type { ConnectionInput } from '@platform/contracts';
import { errorMessage } from '../../shared/errors.js';

export function redactConnectionText(message: string, config: ConnectionInput) {
  let result = message;
  const secrets = [
    ...Object.values(config.headers),
    ...Object.values(config.env),
    config.oauth?.clientSecret,
    ...Object.values(config.openapi?.credentials ?? {}).flatMap((credential) => [
      credential.value,
      credential.password,
      credential.clientSecret,
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, '[redacted]');
  }
  return result
    .replace(/([?&](?:code|token|key|state|client_secret|access_token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(\bauthorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s,;]+/gi, '$1[redacted]')
    .replace(/(\bbearer\s+)[^\s,;]+/gi, '$1[redacted]');
}

export function redactConnectionError(error: unknown, config: ConnectionInput) {
  return redactConnectionText(errorMessage(error), config);
}
