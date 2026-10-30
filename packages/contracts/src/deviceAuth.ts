import { z } from 'zod';
export const DEVICE_AUTH_VERSION = 1;
export const DEVICE_AUTH_LIFETIME_MS = 30_000;
export const DEVICE_AUTH_MAX_BYTES = 4096;
// Canonical unpadded Base64URL for exactly 32 bytes, including zero unused bits.
export const deviceAuthBytes = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const deviceAuthChallenge = z
  .object({
    type: z.literal('auth.challenge'),
    v: z.literal(DEVICE_AUTH_VERSION),
    nonce: deviceAuthBytes,
    expiresAt: z.iso.datetime(),
    /** PUBLIC_URL origin the MAC is bound to; informational, connectors still sign their own --server. */
    origin: z.string().optional(),
  })
  .strict();
/** Sent by a connector that refuses to sign because its --server origin differs from `origin`. */
export const deviceAuthAbort = z
  .object({
    type: z.literal('auth.abort'),
    v: z.literal(DEVICE_AUTH_VERSION),
    reason: z.literal('origin_mismatch'),
  })
  .strict();
export const deviceAuthResponse = z
  .object({
    type: z.literal('auth.response'),
    v: z.literal(DEVICE_AUTH_VERSION),
    deviceId: z.uuid(),
    credentialVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    mac: deviceAuthBytes,
  })
  .strict();
export type DeviceAuthChallenge = z.infer<typeof deviceAuthChallenge>;
export type DeviceAuthResponse = z.infer<typeof deviceAuthResponse>;
export function deviceAuthInput(input: {
  platformOrigin: string;
  deviceId: string;
  credentialVersion: number;
  challenge: DeviceAuthChallenge;
}) {
  return JSON.stringify([
    'mcplatform-device-auth',
    DEVICE_AUTH_VERSION,
    new URL(input.platformOrigin).origin,
    input.deviceId,
    input.credentialVersion,
    input.challenge.nonce,
    input.challenge.expiresAt,
  ]);
}
