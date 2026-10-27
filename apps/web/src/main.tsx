import { RouterProvider, createRouter } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { routeTree } from './routeTree.gen.js';
import './index.css';
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5000, retry: false, refetchOnWindowFocus: true } },
});
const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPendingComponent: () => <p>正在加载…</p>,
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
