import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { activitySearch } from '../features/activity/activitySearch.js';
export const Route = createFileRoute('/activity')({
  validateSearch: (search) => activitySearch.parse(search),
  component: lazyRouteComponent(() => import('../features/activity/ActivityPage.js')),
});
