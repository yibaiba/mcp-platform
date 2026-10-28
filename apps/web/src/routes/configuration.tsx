import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
export const Route = createFileRoute('/configuration')({
  component: lazyRouteComponent(() => import('../features/configuration/ConfigurationPage.js')),
});
