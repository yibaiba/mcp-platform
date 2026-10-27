import { BookOpen, Cloud, GitBranch, Github, ListTodo, Notebook, Plug } from 'lucide-react';

const icons = {
  cloudflare: Cloud,
  github: Github,
  gitee: GitBranch,
  notion: Notebook,
  linear: ListTodo,
  'cloudflare-docs': BookOpen,
};

export function ConnectorIcon({ presetId }: { presetId?: string }) {
  const Icon = icons[presetId as keyof typeof icons] ?? Plug;
  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-foreground">
      <Icon size={20} aria-hidden="true" />
    </div>
  );
}
