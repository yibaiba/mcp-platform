import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
export const Route = createFileRoute('/system-logs')({
  component: lazyRouteComponent(() => import('../features/activity/SystemLogsPage.js')),
});
