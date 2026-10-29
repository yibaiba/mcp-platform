import { z } from 'zod';
const port = z.number().int().min(1).max(65535);
export const sshAccessInput = z
  .object({
    name: z.string().trim().min(1),
    platform: z.enum(['windows', 'macos', 'linux', 'other']),
    ssh: z
      .object({
        host: z
          .string()
          .trim()
          .toLowerCase()
          .refine(
            (host) =>
              z.ipv4().safeParse(host).success ||
              z.ipv6().safeParse(host).success ||
              (host.length <= 253 &&
                host
                  .split('.')
                  .every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))),
            'SSH 主机必须是 IP 或域名',
          ),
        port: port.default(22),
        username: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/),
        identityFile: z
          .string()
          .trim()
          .min(1)
          .refine((value) => !/[\r\n\0]/.test(value), '私钥路径不能包含控制字符'),
        reconnectIntervalSeconds: z.number().int().positive().default(5),
      })
      .strict(),
    bindings: z
      .array(z.object({ connectionId: z.uuid(), localPort: port, remotePort: port }).strict())
      .min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const key of ['connectionId', 'remotePort'] as const)
      if (new Set(value.bindings.map((binding) => binding[key])).size !== value.bindings.length)
        ctx.addIssue({ code: 'custom', path: ['bindings'], message: `${key} 不能重复` });
  });
export type SshAccessInput = z.infer<typeof sshAccessInput>;
export type SshAccessView = SshAccessInput & {
  id: string;
  revision: number;
  tunnelStatus: 'unreported';
  services: {
    connectionId: string;
    name: string;
    status: string;
    error: string | null;
    configurationError: string | null;
  }[];
};
