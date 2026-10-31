import {
  Bot,
  History,
  LayoutDashboard,
  Monitor,
  Plug,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export type SectionTab = {
  to: string;
  label: string;
  /** Extra search params that identify the tab (e.g. devices `?tab=ssh`). */
  search?: Record<string, string>;
  adminOnly?: boolean;
  /** Shown but explained by a tooltip when the feature is off. */
  needsPi?: boolean;
};
export type Section = {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Paths that keep this section highlighted. */
  match: string[];
  tabs?: SectionTab[];
};

/**
 * Six first-level sections. Every original route stays reachable: as a section, as a tab
 * inside one, or from the account menu (account, users, network, about).
 */
export const sections: Section[] = [
  { to: '/', label: '概览', icon: LayoutDashboard, match: ['/'] },
  {
    to: '/connections',
    label: '连接',
    icon: Plug,
    match: ['/connections', '/market', '/authorizations'],
    tabs: [
      { to: '/connections', label: '我的连接' },
      { to: '/market', label: '市场' },
      { to: '/authorizations', label: '服务授权' },
    ],
  },
  {
    to: '/devices',
    label: '设备',
    icon: Monitor,
    match: ['/devices'],
    tabs: [
      { to: '/devices', label: '设备' },
      { to: '/devices', label: 'SSH 接入', search: { tab: 'ssh' } },
    ],
  },
  { to: '/tools', label: '工具', icon: Wrench, match: ['/tools'] },
  {
    to: '/profiles',
    label: 'Agent',
    icon: Bot,
    match: ['/profiles', '/library', '/skills', '/artifacts', '/configuration'],
    tabs: [
      { to: '/profiles', label: 'Agent' },
      { to: '/library', label: '提示词与资源' },
      { to: '/skills', label: 'Skills' },
      { to: '/artifacts', label: '文件' },
      { to: '/configuration', label: '批量配置' },
    ],
  },
  {
    to: '/activity',
    label: '运行记录',
    icon: History,
    match: ['/activity', '/tasks', '/system-logs'],
    tabs: [
      { to: '/activity', label: '调用' },
      { to: '/tasks', label: '内置 Agent', needsPi: true },
      { to: '/system-logs', label: '系统日志', adminOnly: true },
    ],
  },
];

export const sectionFor = (pathname: string) =>
  sections.find((section) =>
    section.match.some((path) => (path === '/' ? pathname === '/' : pathname.startsWith(path))),
  );
