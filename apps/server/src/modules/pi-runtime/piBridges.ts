import { resolve } from 'node:path';
import {
  isInputRequiredResult,
  parseCatalog,
  type McpOperation,
  type McpRequestOptions,
} from '@platform/mcp';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../../config.js';
import type { ConnectionAdapter, ConnectionContext } from '../mcp/adapter.js';
import { oauthCallbackUrl } from '../authorizations/browserFlow.js';
import type { DiagnosticLogger } from '../activity/systemLogger.js';
export interface PiBridge extends ConnectionAdapter {
  action(input: Record<string, unknown>): Promise<unknown>;
}
export type PiRuntime = typeof import('@platform/pi-runtime');
export class PiBridges {
  private readonly entries = new Map<string, Promise<PiBridge>>();
  constructor(
    private readonly deps: {
      config: Config;
      load: () => Promise<PiRuntime>;
      logger: DiagnosticLogger;
    },
  ) {}
  async bridge(context: ConnectionContext) {
    let bridge = this.entries.get(context.runtimeKey ?? context.id);
    if (!bridge) {
      bridge = this.deps.load().then(async (runtime) => {
        const adapter = await runtime.bridge({
          context: {
            ...context,
            oauthRedirectUri: oauthCallbackUrl(context, this.deps.config.PUBLIC_URL),
          },
          diagnostic: (code) => this.deps.logger.report(code, context.ownerId),
          authorizationKey: this.deps.config.PI_MCP_ADAPTER_OAUTH_FILE_KEY,
          directory: resolve(
            this.deps.config.DATA_DIR,
            'pi',
            context.credentialScope?.ownerId ?? context.ownerId,
            context.credentialScope?.bindingId ?? context.bindingId ?? context.id,
          ),
        });
        return {
          status: () => adapter.status(),
          discover: async (signal?: AbortSignal) =>
            parseCatalog(await adapter.catalog(signal)).tools,
          catalog: async (signal?: AbortSignal) => parseCatalog(await adapter.catalog(signal)),
          request: (operation: McpOperation, options?: McpRequestOptions) =>
            adapter.request(operation, options),
          watch: adapter.watch,
          check: adapter.check,
          call: async (input: Parameters<ConnectionAdapter['call']>[0]) =>
            (async () => {
              const result = await adapter.call(input);
              return isInputRequiredResult(result) ? result : CallToolResultSchema.parse(result);
            })(),
          action: (input: Record<string, unknown>) => adapter.action(input),
          close: async () => {
            this.entries.delete(context.runtimeKey ?? context.id);
            await adapter.close();
          },
        };
      });
      this.entries.set(context.runtimeKey ?? context.id, bridge);
    }
    return bridge;
  }
  async close() {
    await Promise.all([...this.entries.values()].map(async (bridge) => (await bridge).close()));
  }
}
