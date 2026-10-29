import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
export const Route = createFileRoute('/network')({
  component: lazyRouteComponent(() => import('../features/network/NetworkPage.js')),
});
