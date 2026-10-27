import { z } from 'zod';
import type { ConnectionContext } from '../mcp/adapter.js';
import type { DeviceBroker } from '../devices/deviceBroker.js';
import { AppError } from '../../shared/errors.js';
const responseSchema = z
  .object({ status: z.number().int(), headers: z.record(z.string(), z.string()), body: z.string() })
  .strict();

/** Private OAuth transport: reachable only from SDK authorization, never a catalog/tool or HTTP API. */
export function deviceAuthFetch(context: ConnectionContext, broker: DeviceBroker): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (!['GET', 'POST'].includes(request.method))
      throw new AppError('OAUTH_METHOD', '设备授权通道只接受 OAuth GET/POST');
    broker.requireCapability(context.config.deviceId!, 'oauth');
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const result = responseSchema.parse(
      await broker.request(context.config.deviceId!, {
        method: 'oauth.request',
        signal: request.signal,
        params: {
          connectionId: context.id,
          bindingId: context.bindingId,
          config: context.config,
          url: request.url,
          method: request.method,
          headers,
          body: request.method === 'POST' ? await request.text() : undefined,
        },
      }),
    );
    return new Response(result.body, { status: result.status, headers: result.headers });
  };
}
