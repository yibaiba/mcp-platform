import { Button } from '../ui/button.js';
import { Link, Outlet } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Network,
  LayoutDashboard,
  Plug,
  Monitor,
  Wrench,
  KeyRound,
  BookOpen,
  Bot,
  History,
  FolderOpen,
  ShieldCheck,
  LogOut,
  ArrowUpRight,
} from 'lucide-react';
import { authClient } from '../../lib/auth-client.js';
import { api } from '../../lib/api.js';
import { AuthScreen } from './AuthScreen.js';
import { Feedback } from './Controls.js';
const navigation = [
  ['/', '概览', LayoutDashboard],
  ['/connections', 'MCP 连接', Plug],
  ['/devices', '设备', Monitor],
  ['/tools', '工具目录', Wrench],
  ['/profiles', 'Agent 配置', KeyRound],
  ['/authorizations', '授权连接', ShieldCheck],
  ['/skills', 'Skills', BookOpen],
  ['/artifacts', '产物', FolderOpen],
  ['/activity', '运行记录', History],
  ['/tasks', '内置 Agent', Bot],
] as const;
export function Shell() {
  const { data: session, isPending, error } = authClient.useSession();
  const info = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ piEnabled: boolean }>('/me'),
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
        <Link to="/" className="brand">
          <Network size={27} />
          <span>
            MCP <b>Platform</b>
          </span>
        </Link>
        <div className="workspace">
          <span className="workspace-avatar">P</span>
          <div>
            <strong>个人工作空间</strong>
            <small>自托管 · 多设备</small>
          </div>
          <ShieldCheck size={16} />
        </div>
        <span className="nav-label">工作空间</span>
        <nav aria-label="主导航">
          {navigation.map(([to, label, Icon]) => (
            <Link
              key={to}
              to={to}
              activeOptions={{ exact: to === '/' }}
              activeProps={{ className: 'active' }}
            >
              <Icon size={18} />
              <span>{label}</span>
              {to === '/tasks' && !info.data?.piEnabled ? <small>可选</small> : null}
            </Link>
          ))}
        </nav>
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
            工作空间 <span className="divider">/</span> 管理控制台
          </span>
          <span className="topbar-meta">
            <span className="status status-online">
              <i />
              自主托管
            </span>
            <span className="version">v0.1</span>
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
