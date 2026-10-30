import { useNavigate } from '@tanstack/react-router';
import {
  CircleHelp,
  CornerDownLeft,
  Globe,
  Info,
  LogOut,
  Monitor,
  Moon,
  Search,
  Sun,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.js';
import { authClient } from '../../lib/auth-client.js';
import { setThemePreference } from '../../lib/theme.js';
import { sections } from './navigation.js';

type Command = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  keywords?: string;
  run: () => void;
};

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const commandShortcut = isMac ? '⌘K' : 'Ctrl K';

/**
 * ⌘K / Ctrl+K command palette. Front-end only: it jumps to existing routes and tabs and runs
 * actions that already exist elsewhere in the UI (theme, guide, sign-out).
 */
export function CommandPalette({
  open,
  onOpenChange,
  admin,
  piEnabled,
  onGuide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  admin: boolean;
  piEnabled: boolean;
  onGuide: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<Command[]>(() => {
    const go = (to: string, search?: Record<string, string>) => () =>
      void navigate({ to, search: search ?? {} });
    const pages: Command[] = sections.flatMap((section) => {
      const tabs = (section.tabs ?? []).filter(
        (tab) => (!tab.adminOnly || admin) && (!tab.needsPi || piEnabled),
      );
      if (!tabs.length)
        return [
          {
            id: section.to,
            group: '页面',
            label: section.label,
            icon: section.icon,
            run: go(section.to),
          },
        ];
      return tabs.map((tab) => ({
        id: `${tab.to}?${new URLSearchParams(tab.search).toString()}`,
        group: '页面',
        label: tab.label === section.label ? section.label : `${section.label} · ${tab.label}`,
        icon: section.icon,
        keywords: tab.to,
        run: go(tab.to, tab.search),
      }));
    });
    return [
      ...pages,
      {
        id: 'account',
        group: '账号与系统',
        label: '个人账号',
        icon: UserRound,
        run: go('/account'),
      },
      ...(admin
        ? [
            { id: 'users', group: '账号与系统', label: '用户管理', icon: Users, run: go('/users') },
            {
              id: 'network',
              group: '账号与系统',
              label: '网络与安装源',
              icon: Globe,
              run: go('/network'),
            },
          ]
        : []),
      { id: 'about', group: '账号与系统', label: '关于与更新', icon: Info, run: go('/about') },
      {
        id: 'theme-dark',
        group: '外观',
        label: '切换到深色',
        icon: Moon,
        keywords: 'dark theme 主题',
        run: () => setThemePreference('dark'),
      },
      {
        id: 'theme-light',
        group: '外观',
        label: '切换到浅色',
        icon: Sun,
        keywords: 'light theme 主题',
        run: () => setThemePreference('light'),
      },
      {
        id: 'theme-system',
        group: '外观',
        label: '跟随系统主题',
        icon: Monitor,
        keywords: 'system theme 主题',
        run: () => setThemePreference('system'),
      },
      {
        id: 'guide',
        group: '其他',
        label: '使用指南',
        icon: CircleHelp,
        keywords: 'help guide 帮助',
        run: onGuide,
      },
      {
        id: 'sign-out',
        group: '其他',
        label: '退出登录',
        icon: LogOut,
        keywords: 'logout sign out',
        run: () => void authClient.signOut().then(() => window.location.reload()),
      },
    ];
  }, [admin, piEnabled, navigate, onGuide]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.keywords ?? ''} ${command.group}`.toLowerCase().includes(needle),
    );
  }, [commands, query]);

  useEffect(() => setActive(0), [query, open]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    onOpenChange(false);
    command.run();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!results.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((index) => (index + step + results.length) % results.length);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : results.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(results[active]);
    }
  };

  const groups = [...new Set(results.map((command) => command.group))];
  const optionId = (index: number) => `${listId}-option-${index}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="command-palette" showCloseButton={false}>
        <DialogTitle className="sr-only">命令面板</DialogTitle>
        <DialogDescription className="sr-only">
          输入以筛选页面和操作，用上下方向键选择，回车执行，Esc 关闭。
        </DialogDescription>
        <div className="command-input">
          <Search size={16} aria-hidden="true" />
          <input
            autoFocus
            role="combobox"
            aria-label="搜索页面和操作"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={results.length ? optionId(active) : undefined}
            placeholder="跳转到页面，或切换主题…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="kbd">Esc</kbd>
        </div>
        <div className="command-list" id={listId} role="listbox" aria-label="结果" ref={listRef}>
          {results.length ? (
            groups.map((group) => (
              <div key={group} role="group" aria-label={group}>
                <div className="command-group" aria-hidden="true">
                  {group}
                </div>
                {results.map((command, index) =>
                  command.group === group ? (
                    <div
                      key={command.id}
                      id={optionId(index)}
                      data-index={index}
                      role="option"
                      aria-selected={index === active}
                      className="command-item"
                      onMouseMove={() => setActive(index)}
                      onClick={() => run(command)}
                    >
                      <command.icon size={16} aria-hidden="true" />
                      <span>{command.label}</span>
                      {index === active ? (
                        <CornerDownLeft size={14} className="command-enter" aria-hidden="true" />
                      ) : null}
                    </div>
                  ) : null,
                )}
              </div>
            ))
          ) : (
            <p className="command-empty" role="status">
              没有匹配的页面或操作
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Opens the palette on ⌘K / Ctrl+K from anywhere in the app. */
export function useCommandShortcut(toggle: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
}
