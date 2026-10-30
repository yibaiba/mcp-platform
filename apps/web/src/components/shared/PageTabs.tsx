import { Link, useRouterState } from '@tanstack/react-router';
import { Hint } from '../ui/tooltip.js';
import { sectionFor } from './navigation.js';

/**
 * Route tabs for the current section. Real links, so a tab URL can be shared and refreshed.
 * Hidden on pages outside a tabbed section and on secondary pages (e.g. an Agent workspace).
 */
export function PageTabs({ admin, piEnabled }: { admin: boolean; piEnabled: boolean }) {
  const location = useRouterState({ select: (state) => state.location });
  const section = sectionFor(location.pathname);
  const search = location.search as Record<string, unknown>;
  if (!section?.tabs || search.workspace || search.device) return null;
  const tabs = section.tabs.filter((tab) => !tab.adminOnly || admin);
  return (
    <nav className="page-tabs" aria-label={`${section.label}子页面`}>
      {tabs.map((tab) => {
        const active =
          location.pathname === tab.to &&
          (tab.search
            ? Object.entries(tab.search).every(([key, value]) => search[key] === value)
            : !search.tab);
        const link = (
          <Link
            key={tab.label}
            to={tab.to}
            search={tab.search ?? {}}
            className={`page-tab${active ? ' active' : ''}${tab.needsPi && !piEnabled ? ' inactive' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        );
        return tab.needsPi && !piEnabled ? (
          <Hint key={tab.label} content="未启用，需配置模型">
            {link}
          </Hint>
        ) : (
          link
        );
      })}
    </nav>
  );
}
