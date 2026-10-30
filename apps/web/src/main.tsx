import { RouterProvider, createRouter } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { routeTree } from './routeTree.gen.js';
import { ListSkeleton } from './components/shared/Controls.js';
import { initTheme } from './lib/theme.js';
import './index.css';
import './workspace-polish.css';
import './motion.css';
initTheme();
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5000, retry: false, refetchOnWindowFocus: true } },
});
const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPendingComponent: () => (
    <>
      <div className="route-progress" aria-hidden="true" />
      <ListSkeleton />
    </>
  ),
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
createRoot(document.getElementById('app')!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
