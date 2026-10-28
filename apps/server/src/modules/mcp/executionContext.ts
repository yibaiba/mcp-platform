import { AsyncLocalStorage } from 'node:async_hooks';
import { digest } from '../../shared/crypto.js';
import type { ConnectionInput } from '@platform/contracts';

export type ExecutionContext = {
  readonly identity: string;
  readonly ownerId?: string;
  readonly credentialId?: string;
  readonly bindingIdentity?: string;
  readonly profileId?: string;
  readonly taskId?: string;
  readonly appId?: string;
  readonly signal?: AbortSignal;
  readonly entry: 'gateway' | 'dashboard' | 'pi' | 'rest';
  readonly sessionId: string;
  readonly capabilities: Record<string, unknown>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly correlationId?: string;
};
export const PLATFORM_CAPABILITIES = {
  elicitation: { form: {}, url: {} },
  extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
};
const execution = new AsyncLocalStorage<ExecutionContext>();
export const currentExecution = () => execution.getStore();
export const withExecution = <T>(context: ExecutionContext, action: () => T): T =>
  execution.run(context, action);

export function sessionScope(
  config: ConnectionInput,
  selected?: 'inherit' | 'profile' | 'credential',
) {
  const caller = currentExecution();
  const identity =
    caller?.bindingIdentity ??
    (selected === 'profile' && caller?.profileId
      ? `profile:${caller.profileId}`
      : selected === 'credential'
        ? (caller?.credentialId ?? caller?.identity ?? 'dashboard')
        : config.identityMode === 'independent'
          ? (caller?.identity ?? 'dashboard')
          : 'default');
  const headers: Record<string, string> = {};
  for (const field of config.forwardHeaders) {
    const value = caller?.headers?.[field.toLowerCase()];
    if (value !== undefined) headers[field.toLowerCase()] = value;
  }
  const capabilityKey = digest(
    stable({ capabilities: caller?.capabilities ?? PLATFORM_CAPABILITIES, headers }),
  );
  const dashboard =
    !caller ||
    (caller.entry === 'dashboard' &&
      caller.identity === 'dashboard' &&
      caller.sessionId === 'dashboard');
  const session = dashboard
    ? 'dashboard'
    : `${caller.entry}:${caller.identity}:${caller.sessionId}`;
  return { identity, headers, capabilityKey, session, headerKey: digest(stable(headers)) };
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stable(item))));
  if (value && typeof value === 'object')
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, JSON.parse(stable(item))]),
      ),
    );
  return JSON.stringify(value);
}
