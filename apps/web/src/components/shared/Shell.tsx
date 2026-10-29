import type { VersionStatus } from '../../features/updates/AboutPage.js';
import { Button } from '../ui/button.js';
import { Link, Outlet } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Network, ShieldCheck, LogOut, ArrowUpRight, Menu } from 'lucide-react';
import { useState } from 'react';
import { WorkspaceNavigation } from './WorkspaceNavigation.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { authClient } from '../../lib/auth-client.js';
import { api } from '../../lib/api.js';
import { AuthScreen } from './AuthScreen.js';
import { Feedback } from './Controls.js';
import { GettingStarted } from '../../features/onboarding/GettingStarted.js';
export function Shell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { data: session, isPending, error } = authClient.useSession();
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
  if (isPending) return <div className="auth-screen">正在加载会话…</div>;
  if (error)
    return (
      <div className="auth-screen" role="alert">
        会话加载失败：{error.message}
      </div>
    );
  if (!session) return <AuthScreen />;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand-row">
          <Link to="/" className="brand">
            <Network size={27} />
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
              <DialogTitle>工作空间导航</DialogTitle>
            </DialogHeader>
            <WorkspaceNavigation
              admin={info.data?.role === 'admin'}
              piEnabled={Boolean(info.data?.piEnabled)}
              onNavigate={() => setMenuOpen(false)}
            />
            <div className="account">
              <div>
                <strong>{session.user.name}</strong>
                <small>{session.user.email}</small>
              </div>
              <Button
                variant="outline"
                aria-label="退出登录"
                onClick={() => void authClient.signOut().then(() => window.location.reload())}
              >
                <LogOut size={17} />
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        <div className="workspace">
          <span className="workspace-avatar">P</span>
          <div>
            <strong>个人工作空间</strong>
            <small>自托管 · 多设备</small>
          </div>
          <ShieldCheck size={16} />
        </div>
        <WorkspaceNavigation
          admin={info.data?.role === 'admin'}
          piEnabled={Boolean(info.data?.piEnabled)}
        />
        <div className="sidebar-bottom">
          <div className="core-note">
            <i />
            <span>核心服务不依赖模型</span>
            <ArrowUpRight size={14} />
          </div>
          <div className="account">
            <div className="avatar">{session.user.name.slice(0, 1).toUpperCase()}</div>
            <div>
              <strong>{session.user.name}</strong>
              <small>{session.user.email}</small>
            </div>
            <Button
              aria-label="退出登录"
              onClick={() => void authClient.signOut().then(() => window.location.reload())}
            >
              <LogOut size={17} />
            </Button>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <span>
            工作空间{' '}
            <span className="desktop-breadcrumb">
              <span className="divider">/</span> 管理控制台
            </span>
          </span>
          <span className="topbar-meta">
            <GettingStarted />
            <span className="status status-online">
              <i />
              自主托管
            </span>
            <Link to="/about" className="version">
              {version.data
                ? version.data.build.release
                  ? version.data.build.version
                  : `dev · ${version.data.build.commit.slice(0, 8)}`
                : '版本信息'}
            </Link>
          </span>
        </header>
        <main className="page">
          <Feedback error={info.error} />
          <Outlet />
        </main>
        <footer>
          连接你的工具与设备 <span>MCP Platform / 个人版</span>
        </footer>
      </div>
    </div>
  );
}
