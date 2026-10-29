import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
export const Route = createFileRoute('/library')({
  component: lazyRouteComponent(() => import('../features/library/LibraryPage.js')),
});
