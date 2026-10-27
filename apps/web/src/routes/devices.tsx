import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
export const Route = createFileRoute('/devices')({
  component: lazyRouteComponent(() => import('../features/devices/DevicesPage.js')),
});
