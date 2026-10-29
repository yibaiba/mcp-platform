import { Link } from '@tanstack/react-router';
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
} from 'lucide-react';
const navigation = [
  ['/', '概览', LayoutDashboard],
  ['/connections', 'MCP 连接', Plug],
  ['/market', '服务市场', BookOpen],
  ['/devices', '设备', Monitor],
  ['/tools', '工具目录', Wrench],
  ['/profiles', 'Agent 配置', KeyRound],
  ['/configuration', '配置模板', BookOpen],
  ['/authorizations', '授权连接', ShieldCheck],
  ['/library', '内容库', BookOpen],
  ['/skills', 'Skills', BookOpen],
  ['/artifacts', '产物', FolderOpen],
  ['/activity', '运行记录', History],
  ['/tasks', '内置 Agent', Bot],
  ['/account', '个人账号', KeyRound],
  ['/users', '用户管理', ShieldCheck],
  ['/about', '关于与更新', BookOpen],
  ['/network', '网络与安装源', Network],
  ['/system-logs', '系统日志', History],
] as const;
const groups = [
  { title: '连接与设备', paths: ['/', '/connections', '/market', '/devices', '/tools'] },
  {
    title: 'Agent 与内容',
    paths: ['/profiles', '/configuration', '/authorizations', '/library', '/skills', '/artifacts'],
  },
  {
    title: '运行与管理',
    paths: ['/activity', '/tasks', '/account', '/users', '/about', '/network', '/system-logs'],
  },
];
export function WorkspaceNavigation({
  admin,
  piEnabled,
  onNavigate,
}: {
  admin: boolean;
  piEnabled: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="主导航" className="workspace-navigation">
      {groups.map((group) => (
        <section key={group.title}>
          <h2 className="nav-label">{group.title}</h2>
          {navigation
            .filter(
              ([to]) =>
                group.paths.includes(to) &&
                (!['/users', '/system-logs', '/network'].includes(to) || admin),
            )
            .map(([to, label, Icon]) => (
              <Link
                key={to}
                to={to}
                onClick={onNavigate}
                activeOptions={{ exact: to === '/' }}
                activeProps={{ className: 'active', 'aria-current': 'page' }}
              >
                <Icon size={18} />
                <span>{label}</span>
                {to === '/tasks' && !piEnabled ? <small>可选</small> : null}
              </Link>
            ))}
        </section>
      ))}
    </nav>
  );
}
