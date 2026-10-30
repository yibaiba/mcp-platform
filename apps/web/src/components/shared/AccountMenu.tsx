import { Link } from '@tanstack/react-router';
import { ChevronsUpDown, CircleHelp, Globe, Info, LogOut, UserRound, Users } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';
import { authClient } from '../../lib/auth-client.js';

/** Bottom-left account menu: personal and system pages, guide, version and sign-out. */
export function AccountMenu({
  user,
  admin,
  version,
  onGuide,
  onNavigate,
}: {
  user: { name: string; email: string };
  admin: boolean;
  version?: string;
  onGuide: () => void;
  onNavigate?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="account" aria-label="账号菜单">
        <span className="avatar" aria-hidden="true">
          {user.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="account-name">
          <strong>{user.name}</strong>
          <small>{user.email}</small>
        </span>
        <ChevronsUpDown size={14} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="account-menu min-w-56">
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
        <DropdownMenuItem
          onClick={() => void authClient.signOut().then(() => window.location.reload())}
        >
          <LogOut /> 退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
