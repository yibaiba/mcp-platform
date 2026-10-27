import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';
import { toolSearch } from '../features/tools/toolCatalog.js';
export const Route = createFileRoute('/tools')({
  validateSearch: (search) => toolSearch.parse(search),
  component: lazyRouteComponent(() => import('../features/tools/ToolsPage.js')),
});
