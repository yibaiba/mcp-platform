import { createAuthClient } from 'better-auth/react';
import { genericOAuthClient } from 'better-auth/client/plugins';
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/v1/auth',
  plugins: [genericOAuthClient()],
});
