import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
export const Route = createFileRoute('/connections')({
  component: lazyRouteComponent(() => import('../features/connections/ConnectionsPage.js')),
});
