import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
export const Route = createFileRoute('/activity')({
  component: lazyRouteComponent(() => import('../features/activity/ActivityPage.js')),
});
