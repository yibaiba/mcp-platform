import { Link } from '@tanstack/react-router';
import {
  ChevronsUpDown,
  CircleHelp,
  Globe,
  Info,
  LogOut,
  Monitor,
  Moon,
  Sun,
  UserRound,
  Users,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';
import { Badge } from '../ui/badge.js';
import { authClient } from '../../lib/auth-client.js';
import { roleLabel, type Role } from '../../lib/me.js';
import { setThemePreference, useThemePreference, type ThemePreference } from '../../lib/theme.js';

const themes = [
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'system', label: '跟随系统', icon: Monitor },
] as const;

/** Bottom-left account menu: personal and system pages, guide, version and sign-out. */
export function AccountMenu({
  user,
  role,
  version,
  onGuide,
  onNavigate,
}: {
  user: { name: string; email: string };
  /** Undefined while /me loads; the badge appears once the role is known. */
  role?: Role;
  version?: string;
  onGuide: () => void;
  onNavigate?: () => void;
}) {
  const theme = useThemePreference();
  const admin = role === 'admin';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="account" aria-label="账号菜单">
        <span className="avatar" aria-hidden="true">
          {user.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="account-name">
          <span className="account-title">
            <strong>{user.name}</strong>
            {role ? (
              <Badge variant={admin ? 'secondary' : 'outline'} className="account-role">
                {roleLabel[role]}
              </Badge>
            ) : null}
          </span>
          <small>{user.email}</small>
        </span>
        <ChevronsUpDown size={14} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="account-menu min-w-56">
        {role ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel>
              当前角色<span className="menu-meta">{roleLabel[role]}</span>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
        ) : null}
        <DropdownMenuItem render={<Link to="/account" onClick={onNavigate} />}>
          <UserRound /> 个人账号
        </DropdownMenuItem>
        {admin ? (
          <>
            <DropdownMenuItem render={<Link to="/users" onClick={onNavigate} />}>
              <Users /> 用户管理
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link to="/network" onClick={onNavigate} />}>
              <Globe /> 网络与安装源
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuItem render={<Link to="/about" onClick={onNavigate} />}>
          <Info /> 关于与更新
          {version ? <span className="menu-meta">{version}</span> : null}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            onNavigate?.();
            onGuide();
          }}
        >
          <CircleHelp /> 使用指南
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>外观</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={theme}
            onValueChange={(value) => setThemePreference(value as ThemePreference)}
          >
            {themes.map(({ value, label, icon: Icon }) => (
              <DropdownMenuRadioItem key={value} value={value} closeOnClick={false}>
                <Icon /> {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => void authClient.signOut().then(() => window.location.reload())}
        >
          <LogOut /> 退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
