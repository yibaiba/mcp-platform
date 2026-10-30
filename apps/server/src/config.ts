import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { providerConfig } from '@platform/auth/providers';
export const platformRoot = fileURLToPath(new URL('../../../', import.meta.url));
// Compose represents absent optional settings as empty environment strings.
const optionalSetting = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
export const envSchema = z
  .object({
    DATABASE_URL: z.url(),
    PUBLIC_URL: z.url(),
    WEB_ORIGIN: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    ENCRYPTION_KEY: z.string(),
    DEVICE_AUTH_ENCRYPTION_KEY: z.string().refine((value) => {
      const key = Buffer.from(value, 'base64');
      return key.length === 32 && key.toString('base64') === value;
    }, 'DEVICE_AUTH_ENCRYPTION_KEY must be canonical base64 for 32 bytes'),

    PORT: z.coerce.number().int().positive().default(4300),
    DATA_DIR: z.string().default('.data'),
    ALLOW_REGISTRATION: z.enum(['true', 'false']).default('false'),
    METRICS_ENABLED: z.enum(['true', 'false']).default('false'),
    METRICS_TOKEN: optionalSetting(z.string().min(32)),
    CALL_RETENTION_DAYS: optionalSetting(z.coerce.number().int().positive()),
    LOG_RETENTION_DAYS: optionalSetting(z.coerce.number().int().positive()),
    CONFIG_MANIFEST_FILE: optionalSetting(z.string().min(1)),
    CONFIG_MANIFEST_OWNER: optionalSetting(z.email()),
    AUTH_PROVIDERS: optionalSetting(
      z
        .string()
        .transform((value, ctx) => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            ctx.addIssue({ code: 'custom', message: 'AUTH_PROVIDERS 必须是 JSON' });
            return z.NEVER;
          }
        })
        .pipe(providerConfig),
    ),
    // Platform-host stdio (direct/Pi adapters spawning processes on the server) is admin-only and off by default.
    PLATFORM_STDIO_ENABLED: z.enum(['true', 'false']).default('false'),
    // Only gates built-in agent tasks; MCP bridging loads independently on demand.
    PI_ENABLED: z.enum(['true', 'false']).default('false'),
    PI_MODEL_PROVIDER: z.string().optional(),
    PI_MODEL_ID: z.string().optional(),
    PI_MCP_ADAPTER_OAUTH_FILE_KEY: z.string().optional(),
  })
  .refine(
    (value) => !value.CONFIG_MANIFEST_FILE || Boolean(value.CONFIG_MANIFEST_OWNER),
    '启动模板必须明确设置 CONFIG_MANIFEST_OWNER',
  )
  .refine(
    (value) => value.METRICS_ENABLED !== 'true' || Boolean(value.METRICS_TOKEN),
    '启用 metrics 时必须配置独立 METRICS_TOKEN',
  );
export type Config = z.infer<typeof envSchema>;
