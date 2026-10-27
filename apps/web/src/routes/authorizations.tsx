import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
export const Route = createFileRoute('/authorizations')({
  component: lazyRouteComponent(() => import('../features/authorizations/AuthorizationsPage.js')),
});
