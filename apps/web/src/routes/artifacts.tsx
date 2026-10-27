import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
export const Route = createFileRoute('/artifacts')({
  component: lazyRouteComponent(() => import('../features/artifacts/ArtifactsPage.js')),
});
