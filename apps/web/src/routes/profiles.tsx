import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { z } from 'zod';
export const Route = createFileRoute('/profiles')({
  validateSearch: (search) => z.object({ workspace: z.string().optional() }).parse(search),
  component: lazyRouteComponent(() => import('../features/profiles/ProfilesPage.js')),
});
