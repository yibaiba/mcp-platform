import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';

export type Me = {
  userId: string;
  role: 'admin' | 'member';
  piEnabled: boolean;
  /** Deployment switch PLATFORM_STDIO_ENABLED. */
  hostStdioEnabled: boolean;
  /** Effective permission: switch on and caller is an admin. */
  hostStdio: boolean;
  /** Canonical external origin (PUBLIC_URL); use it for every address shown or copied. */
  platformOrigin: string;
  /** Admins with host stdio on: STDIO_SANDBOX state (off, ready, or why it cannot run). */
  stdioSandbox?:
    | { mode: 'off' }
    | { mode: 'bwrap'; ready: true; version: string; path: string; proc: 'proc' | 'bind' }
    | { mode: 'bwrap'; ready: false; error: string; hint: string };
};

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me') });
}

export type Role = Me['role'];
/** Display names for roles, shared by the account menu, account page and user admin. */
export const roleLabel: Record<Role, string> = { admin: '管理员', member: '普通用户' };
