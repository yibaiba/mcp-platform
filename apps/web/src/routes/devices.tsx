import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { z } from 'zod';
export const Route = createFileRoute('/devices')({
  validateSearch: (search) =>
    z.object({ tab: z.enum(['ssh']).optional(), device: z.string().optional() }).parse(search),
  component: lazyRouteComponent(() => import('../features/devices/DevicesPage.js')),
});
