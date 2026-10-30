import type { VersionStatus } from '../../features/updates/AboutPage.js';
import { Button } from '../ui/button.js';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Network, Menu, Search } from 'lucide-react';
import { useCallback, useState } from 'react';
import { WorkspaceNavigation } from './WorkspaceNavigation.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { TooltipProvider } from '../ui/tooltip.js';
import { authClient } from '../../lib/auth-client.js';
import { api } from '../../lib/api.js';
import { AuthScreen } from './AuthScreen.js';
import { Feedback } from './Controls.js';
import { AccountMenu } from './AccountMenu.js';
import { PageHeaderProvider } from './PageHeader.js';
import { PageTabs } from './PageTabs.js';
import { GettingStarted } from '../../features/onboarding/GettingStarted.js';
import { CommandPalette, commandShortcut, useCommandShortcut } from './CommandPalette.js';
const noop = () => {};
const openGuide = (set: (open: boolean) => void) => () => set(true);
export function Shell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { data: session, isPending, error } = authClient.useSession();
  const togglePalette = useCallback(() => setPaletteOpen((open) => !open), []);
  useCommandShortcut(session ? togglePalette : noop);
  const info = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ piEnabled: boolean; role: 'admin' | 'member' }>('/me'),
    enabled: Boolean(session),
  });
  const version = useQuery({
    queryKey: ['version'],
    queryFn: () => api<VersionStatus>('/version'),
    enabled: Boolean(session),
  });
  if (isPending)
    return (
      <div className="auth-screen" aria-busy="true">
        <span className="sr-only">加载中</span>
      </div>
    );
  if (error)
    return (
      <div className="auth-screen" role="alert">
        会话加载失败：{error.message}
      </div>
    );
  if (!session) return <AuthScreen />;
  const admin = info.data?.role === 'admin';
  const piEnabled = Boolean(info.data?.piEnabled);
  const versionLabel = version.data
    ? version.data.build.release
      ? version.data.build.version
      : `dev · ${version.data.build.commit.slice(0, 8)}`
    : undefined;
  const guide = openGuide(setGuideOpen);
  const account = (
    <AccountMenu
      user={session.user}
      admin={admin}
      version={versionLabel}
      onGuide={() => setGuideOpen(true)}
      onNavigate={() => setMenuOpen(false)}
    />
  );
  return (
    <TooltipProvider>
      <PageHeaderProvider>
        {(bind) => (
          <div className="app-shell">
            <aside className="sidebar">
              <div className="sidebar-brand-row">
                <Link to="/" className="brand">
                  <Network size={22} />
                  <span>
                    MCP <b>Platform</b>
                  </span>
                </Link>
                <Button
                  variant="outline"
                  className="mobile-menu-button"
                  aria-label="打开导航菜单"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen(true)}
                >
                  <Menu size={20} />
                </Button>
              </div>
              <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
                <DialogContent className="mobile-navigation-drawer">
                  <DialogHeader>
                    <DialogTitle>导航</DialogTitle>
                  </DialogHeader>
                  <WorkspaceNavigation onNavigate={() => setMenuOpen(false)} />
                  {account}
                </DialogContent>
              </Dialog>
              <WorkspaceNavigation />
              <div className="sidebar-bottom">{account}</div>
            </aside>
            <div className="workspace-main">
              <header className="topbar">
                <div className="topbar-title" ref={bind.title} />
                <div className="topbar-actions">
                  <span className="topbar-page-actions" ref={bind.actions} />
                  <button
                    type="button"
                    className="command-trigger"
                    aria-label={`打开命令面板（${commandShortcut}）`}
                    aria-haspopup="dialog"
                    onClick={() => setPaletteOpen(true)}
                  >
                    <Search size={14} aria-hidden="true" />
                    <span className="command-trigger-label">搜索</span>
                    <kbd className="kbd">{commandShortcut}</kbd>
                  </button>
                  <GettingStarted open={guideOpen} onOpenChange={setGuideOpen} />
                </div>
              </header>
              <main className="page">
                <PageTabs admin={admin} piEnabled={piEnabled} />
                <Feedback error={info.error} />
                <div key={pathname} className="page-transition">
                  <Outlet />
                </div>
              </main>
              <CommandPalette
                open={paletteOpen}
                onOpenChange={setPaletteOpen}
                admin={admin}
                piEnabled={piEnabled}
                onGuide={guide}
              />
            </div>
          </div>
        )}
      </PageHeaderProvider>
    </TooltipProvider>
  );
}
