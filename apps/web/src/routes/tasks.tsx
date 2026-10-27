import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
export const Route = createFileRoute('/tasks')({
  component: lazyRouteComponent(() => import('../features/tasks/TasksPage.js')),
});
