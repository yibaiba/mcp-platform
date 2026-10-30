import { Link, useRouterState } from '@tanstack/react-router';
import { sectionFor, sections } from './navigation.js';

export function WorkspaceNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = sectionFor(pathname);
  return (
    <nav aria-label="主导航" className="workspace-navigation">
      {sections.map((section) => {
        const Icon = section.icon;
        const active = current?.to === section.to;
        return (
          <Link
            key={section.to}
            to={section.to}
            onClick={onNavigate}
            className={active ? 'active' : undefined}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={18} aria-hidden="true" />
            <span>{section.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
