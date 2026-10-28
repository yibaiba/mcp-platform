import { credentialScope } from './credentialScope.js';
import type { ConnectionContext } from '../mcp/adapter.js';
import type { ConnectionService } from '../mcp/connectionService.js';

export function oauthCallbackUrl(context: ConnectionContext, publicUrl: string) {
  const scope = credentialScope(context);
  const binding =
    scope.identity && scope.identity !== 'default' ? `/bindings/${scope.bindingId}` : '';
  return `${publicUrl}/api/v1/connections/${scope.connectionId}${binding}/oauth/callback`;
}

export async function finishBrowserAuthorization(options: {
  context: ConnectionContext;
  connections: ConnectionService;
  webOrigin: string;
}) {
  await options.connections.discover(options.context.ownerId, options.context.id);
  const target = new URL('/connections', options.webOrigin);
  target.hash = `connection-${options.context.id}`;
  return Response.redirect(target.href, 303);
}
