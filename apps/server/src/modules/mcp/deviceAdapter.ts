import { isInputRequiredResult } from '@platform/mcp';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { DeviceBroker } from '../devices/deviceBroker.js';
import type { ConnectionAdapter, ConnectionContext } from './adapter.js';
import { parseCatalog } from '@platform/mcp';
export function createDeviceAdapter(
  context: ConnectionContext,
  broker: DeviceBroker,
  authHeaders: () => Promise<Record<string, string>> = async () => ({}),
): ConnectionAdapter {
  const scoped =
    context.sessionId !== 'dashboard' ||
    context.identity !== 'default' ||
    context.config.forwardHeaders.length > 0;
  if (scoped) broker.requireCapability(context.config.deviceId!, 'sessions');
  const sessionId = broker.hasCapability(context.config.deviceId!, 'sessions')
    ? context.runtimeKey
    : undefined;
  const params = {
    connectionId: context.id,
    config: context.config,
    sessionId,
    bindingId: context.bindingId,
    capabilities: context.capabilities,
    correlationId: context.correlationId,
  };
  const authorized = async () => ({
    ...params,
    config: { ...context.config, headers: { ...context.config.headers, ...(await authHeaders()) } },
  });
  const interactions = new Map<string, () => void>();
  return {
    status: () => (broker.online(context.config.deviceId!) ? 'connected' : 'disconnected'),
    watch: (listener) =>
      broker.watch({
        deviceId: context.config.deviceId!,
        connectionId: context.id,
        sessionId,
        listener,
      }),
    catalog: async (signal) =>
      parseCatalog(
        await broker.request(context.config.deviceId!, {
          method: 'catalog',
          params: await authorized(),
          signal,
          executionTimeoutMs: context.config.connectTimeoutMs,
        }),
      ),
    request: async (operation, options) =>
      broker.request(context.config.deviceId!, {
        method: 'mcp.request',
        params: { ...(await authorized()), operation },
        ...options,
      }),
    async discover(signal) {
      return (await this.catalog(signal)).tools;
    },
    async call(input) {
      if (input.requestState) {
        interactions.get(input.requestState)?.();
        interactions.delete(input.requestState);
      }
      const result = await broker.request(context.config.deviceId!, {
        method: 'call',
        params: {
          ...(await authorized()),
          name: input.name,
          arguments: input.arguments,
          requestState: input.requestState,
          inputResponses: input.inputResponses,
        },
        signal: input.signal,
        executionTimeoutMs: input.executionTimeoutMs,
        onprogress: input.onprogress,
      });
      if (!isInputRequiredResult(result)) return CallToolResultSchema.parse(result);
      broker.requireCapability(context.config.deviceId!, 'elicitation');
      const state = result.requestState;
      if (state && input.signal) {
        const signal = input.signal;
        const cancel = () => {
          interactions.delete(state);
          void broker
            .request(context.config.deviceId!, {
              method: 'interaction.cancel',
              params: { ...params, requestState: state },
            })
            .catch((error: unknown) =>
              console.error('Device interaction cancellation failed', error),
            );
        };
        interactions.set(state, () => signal.removeEventListener('abort', cancel));
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      }
      return result;
    },
    async check(signal) {
      broker.requireCapability(context.config.deviceId!, 'health');
      await broker.request(context.config.deviceId!, {
        method: 'check',
        params: await authorized(),
        signal,
        executionTimeoutMs: context.config.health.timeoutMs,
      });
    },
    async close() {
      for (const removeListener of interactions.values()) removeListener();
      interactions.clear();
      if (broker.online(context.config.deviceId!))
        await broker.request(context.config.deviceId!, { method: 'close', params });
    },
  };
}
