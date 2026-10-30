import {
  useId,
  useCallback,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from 'react';
import { PageHeader } from './PageHeader.js';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleCheck, LoaderCircle, ShieldAlert, type LucideIcon } from 'lucide-react';
import { ConfirmDialog, type Confirmation } from './ConfirmDialog.js';
import { FormChanges } from './formChanges.js';
import { Skeleton } from '../ui/skeleton.js';
import { isForbidden } from '../../lib/api.js';
import { Button } from '../ui/button.js';
import { Badge } from '../ui/badge.js';
import { Field as FieldContainer, FieldLabel, FieldDescription } from '../ui/field.js';
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  const descriptionId = hint ? `${id}-hint` : undefined;
  const control = isValidElement<{ id?: string; 'aria-describedby'?: string }>(children)
    ? cloneElement(children, { id, 'aria-describedby': descriptionId })
    : children;
  return (
    <FieldContainer className="field">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {control}
      {hint ? <FieldDescription id={descriptionId}>{hint}</FieldDescription> : null}
    </FieldContainer>
  );
}
/**
 * Empty states: one short title plus at most one action. `children` stays supported for
 * screens that still render free-form content.
 */
export function Empty({
  children,
  icon: Icon,
  title,
  action,
  variant = 'default',
}: {
  children?: ReactNode;
  icon?: LucideIcon;
  title?: string;
  action?: ReactNode;
  variant?: 'default' | 'filtered';
}) {
  return (
    <div className="empty" data-variant={variant}>
      {Icon ? <EmptyArt icon={Icon} /> : null}
      {title ? <h3>{title}</h3> : null}
      {children}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
/**
 * Inline SVG backdrop for empty states: two stacked cards and a soft glow behind the icon.
 * Colors come from CSS variables, so it follows the theme without image assets.
 */
function EmptyArt({ icon: Icon }: { icon: LucideIcon }) {
  const id = useId();
  return (
    <div className="empty-art" aria-hidden="true">
      <svg viewBox="0 0 120 88" width="120" height="88" fill="none">
        <defs>
          <radialGradient id={`${id}-glow`} cx="50%" cy="50%" r="50%">
            <stop
              offset="0%"
              stopColor="var(--primary)"
              style={{ stopOpacity: 'var(--empty-art-glow)' }}
            />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${id}-card`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--muted)" />
            <stop offset="100%" stopColor="var(--card)" />
          </linearGradient>
        </defs>
        <ellipse cx="60" cy="46" rx="56" ry="40" fill={`url(#${id}-glow)`} />
        <rect
          x="22"
          y="22"
          width="64"
          height="44"
          rx="8"
          fill="var(--card)"
          stroke="var(--border)"
          transform="rotate(-6 54 44)"
        />
        <rect
          x="34"
          y="18"
          width="64"
          height="48"
          rx="8"
          fill={`url(#${id}-card)`}
          stroke="var(--border)"
        />
        <rect x="44" y="52" width="28" height="4" rx="2" fill="var(--border)" />
        <rect x="44" y="59" width="18" height="3" rx="1.5" fill="var(--border)" opacity="0.7" />
        <circle cx="96" cy="20" r="2" fill="var(--primary)" opacity="0.7" />
        <circle cx="18" cy="60" r="1.5" fill="var(--info)" opacity="0.7" />
      </svg>
      <Icon className="empty-art-icon" size={22} />
    </div>
  );
}
/** Error block: the original message plus an optional retry that re-runs the request. */
export function ErrorState({
  error,
  onRetry,
  title,
}: {
  error: Error | null | undefined;
  onRetry?: () => unknown;
  title?: string;
}) {
  if (!error) return null;
  return (
    <div className="error error-state" role="alert">
      <div className="min-w-0">
        {title ? <strong>{title}</strong> : null}
        <span>{error.message}</span>
      </div>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={() => void onRetry()}>
          重试
        </Button>
      ) : null}
    </div>
  );
}
export function Feedback({ error, onRetry }: { error: Error | null; onRetry?: () => unknown }) {
  return <ErrorState error={error} onRetry={onRetry} />;
}
/** Short success note next to the control that triggered it; fades after three seconds. */
export function InlineStatus({ children, onDone }: { children: ReactNode; onDone?: () => void }) {
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const timer = setTimeout(() => done.current?.(), 3000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <span role="status" className="inline-status">
      <CircleCheck size={14} aria-hidden="true" />
      {children}
    </span>
  );
}
/**
 * Whole-page state for administrator-only screens opened by other accounts.
 * Pass the page title so the topbar still names the page.
 */
export function Forbidden({ title }: { title?: string }) {
  return (
    <>
      {title ? <PageHeader title={title} /> : null}
      <div className="empty forbidden" role="alert">
        <ShieldAlert size={28} aria-hidden="true" />
        <h3>需要管理员权限</h3>
        <div className="empty-action">
          <Button variant="outline" render={<Link to="/" />}>
            返回概览
          </Button>
        </div>
      </div>
    </>
  );
}
/** Renders `Forbidden` for permission errors, otherwise the error with retry. */
export function QueryError({ error, onRetry }: { error: Error | null; onRetry?: () => unknown }) {
  if (isForbidden(error)) return <Forbidden />;
  return <ErrorState error={error} onRetry={onRetry} title="加载失败" />;
}
/** Placeholder rows that match the height of real list rows. */
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-busy="true" className="list-skeleton">
      <span className="sr-only">加载中</span>
      {Array.from({ length: rows }, (_, index) => (
        <div className="list-skeleton-row" key={index}>
          <Skeleton className="size-8 rounded-sm" />
          <div className="grow space-y-2">
            <Skeleton className="h-3 w-2/5 rounded-sm" />
            <Skeleton className="h-3 w-1/4 rounded-sm" />
          </div>
        </div>
      ))}
    </div>
  );
}
const Spinner = () => (
  <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
);
const statusLabels: Record<string, string> = {
  connected: '已连接',
  disconnected: '待连接',
  stopped: '已停止',
  error: '连接错误',
  succeeded: '成功',
  failed: '失败',
  unknown: '结果未知',
  running: '执行中',
  tool_error: '工具返回错误',
  online: '在线',
  offline: '离线',
  cancelled: '已取消',
  revoked: '已撤销',
  pairing_required: '待重新配对',
  installed: '已安装',
  waiting: '等待上游交互',
  waiting_authorization: '等待平台授权',
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  expired: '已到期',
  invalidated: '配置或身份已改变',
  interrupted: '进程重启已中断',
  queued: '待执行',
  created: '已保存',
  executing: '执行中',
  exported: '外部任务包已就绪',
};
export const statusText = (value: string) => statusLabels[value] ?? value;
export function Status({ value }: { value: string }) {
  return (
    <Badge variant="outline" className={`status status-${value}`}>
      <i aria-hidden="true" />
      {statusText(value)}
    </Badge>
  );
}
export function Action({
  children,
  action,
  danger = false,
  confirmation,
  onError,
  variant,
  confirmed = false,
}: {
  children: ReactNode;
  action: () => Promise<unknown>;
  danger?: boolean;
  confirmation?: Confirmation;
  /** Lets the caller show the failure elsewhere, for example under the owning row. */
  onError?: (error: Error | null) => void;
  variant?: 'outline' | 'ghost' | 'default' | 'destructive';
  /** The surrounding UI already asked the user to confirm (inline confirmation step). */
  confirmed?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const query = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  if (import.meta.env.DEV && danger && !confirmation && !confirmed)
    console.warn('Destructive Action rendered without confirmation:', children);
  async function run() {
    setBusy(true);
    setError(null);
    onError?.(null);
    try {
      await action();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (onError) onError(failure);
      else setError(failure);
    } finally {
      // Failed connection attempts also persist a new diagnostic status.
      await query.invalidateQueries();
      setBusy(false);
    }
  }
  return (
    <span className="action">
      <Button
        variant={variant ?? (danger ? 'destructive' : 'outline')}
        disabled={busy}
        aria-busy={busy}
        type="button"
        onClick={() => (confirmation ? setConfirming(true) : void run())}
      >
        {busy ? <Spinner /> : null}
        {children}
      </Button>
      <Feedback error={error} />
      {confirmation ? (
        <ConfirmDialog
          {...confirmation}
          open={confirming}
          onOpenChange={setConfirming}
          onConfirm={() => {
            setConfirming(false);
            void run();
          }}
          danger={danger}
        />
      ) : null}
    </span>
  );
}
/** Derives a result note that names the action (预览 → 预览已更新, 保存 → 已保存). */
export function successText(label: string) {
  if (/预览/.test(label)) return '预览已更新';
  const rules: [RegExp, string][] = [
    [/^保存/, '已保存'],
    [/^创建/, '已创建'],
    [/^添加/, '已添加'],
    [/^导入/, '已导入'],
    [/^生成/, '已生成'],
    [/上传/, '已上传'],
    [/^安装/, '已安装'],
    [/^更新/, '已更新'],
    [/^批准/, '已批准'],
    [/^测试/, '测试完成'],
  ];
  return rules.find(([pattern]) => pattern.test(label))?.[1] ?? '已完成';
}
type FormFeedback = { version: number | undefined; outcome: 'success' | Error };
export function Form({
  children,
  submit,
  label = '保存',
  successLabel,
  noValidate = false,
  feedbackVersion,
  disabled = false,
  onDirtyChange,
}: {
  children: ReactNode;
  submit: (data: FormData) => Promise<unknown>;
  label?: string;
  /** Names what happened, e.g. 「已创建」; shown next to the submit button. */
  successLabel?: string;
  noValidate?: boolean;
  feedbackVersion?: number;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const query = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<FormFeedback>();
  const form = useRef<HTMLFormElement>(null);
  const initialValues = useRef<string>(undefined);
  const [changes, setChanges] = useState(0);
  const changed = useCallback(() => {
    setFeedback(undefined);
    if (onDirtyChange) setChanges((count) => count + 1);
  }, [onDirtyChange]);
  useEffect(() => {
    if (!onDirtyChange || !form.current) return;
    // Read after controls commit their values, including custom select/checkbox inputs.
    const values = JSON.stringify(Array.from(new FormData(form.current)));
    initialValues.current ??= values;
    onDirtyChange(values !== initialValues.current);
  }, [changes, onDirtyChange]);
  // Async handlers retain the submitted version; edits invalidate their later feedback.
  const outcome = feedback?.version === feedbackVersion ? feedback?.outcome : undefined;
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setFeedback(undefined);
    try {
      await submit(data);
      await query.invalidateQueries();
      setFeedback({ version: feedbackVersion, outcome: 'success' });
    } catch (error) {
      setFeedback({
        version: feedbackVersion,
        outcome: error instanceof Error ? error : new Error(String(error)),
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <FormChanges.Provider value={onDirtyChange ? changed : undefined}>
      <form
        ref={form}
        onSubmit={(e) => void onSubmit(e)}
        onChange={changed}
        className="form"
        noValidate={noValidate}
      >
        <fieldset disabled={busy || disabled} className="form-fields">
          {children}
        </fieldset>
        <Feedback error={outcome instanceof Error ? outcome : null} />
        <div className="form-footer">
          <Button type="submit" disabled={busy || disabled} aria-busy={busy}>
            {busy ? <Spinner /> : null}
            {label}
          </Button>
          {outcome === 'success' ? (
            <InlineStatus onDone={() => setFeedback(undefined)}>
              {successLabel ?? successText(label)}
            </InlineStatus>
          ) : null}
        </div>
      </form>
    </FormChanges.Provider>
  );
}
export const value = (data: FormData, key: string) => String(data.get(key) ?? '');
export const date = (input: string | null) =>
  input ? new Date(input).toLocaleString('zh-CN') : '尚无记录';
/** 「3 分钟前」 style time; pair with `date()` in a tooltip for the exact value. */
export function relativeTime(input: string | null, now = Date.now()) {
  if (!input) return '—';
  const seconds = Math.round((now - new Date(input).getTime()) / 1000);
  if (seconds < 45) return '刚刚';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 2) return '昨天';
  if (days < 30) return `${days} 天前`;
  return new Date(input).toLocaleDateString('zh-CN');
}
export function Code({ value }: { value: unknown }) {
  return (
    <pre className="code">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
  );
}
