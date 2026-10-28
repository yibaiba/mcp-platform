import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
export const Route = createFileRoute('/market')({
  component: lazyRouteComponent(() => import('../features/market/MarketPage.js')),
});
