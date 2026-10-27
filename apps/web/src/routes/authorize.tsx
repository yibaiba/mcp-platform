import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
export const Route = createFileRoute('/authorize')({
  component: lazyRouteComponent(() => import('../features/authorizations/ConsentPage.js')),
});
