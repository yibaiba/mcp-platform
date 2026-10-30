import { Link, useRouterState } from '@tanstack/react-router';
import { sectionFor, sections } from './navigation.js';
import { useSlidingIndicator } from './useSlidingIndicator.js';

export function WorkspaceNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = sectionFor(pathname);
  const indicator = useSlidingIndicator<HTMLElement>('a.active', current?.to);
  return (
    <nav
      aria-label="主导航"
      className="workspace-navigation"
      ref={indicator.ref}
      data-indicator={indicator.style ? '' : undefined}
    >
      <span
        aria-hidden="true"
        className="nav-indicator"
        data-ready={indicator.ready ? '' : undefined}
        style={indicator.style}
        hidden={!indicator.style}
      />
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
