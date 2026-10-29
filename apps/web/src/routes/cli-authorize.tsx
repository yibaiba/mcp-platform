import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
export const Route = createFileRoute('/cli-authorize')({
  component: lazyRouteComponent(() => import('../features/authorizations/CliConsentPage.js')),
});
