import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
export const Route = createFileRoute('/account')({
  component: lazyRouteComponent(() => import('../features/users/AccountPage.js')),
});
