import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, CircleHelp } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog.js';
import { Hint } from '../../components/ui/tooltip.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { glossary } from './glossary.js';

export const setupSteps = [
  {
    title: '添加并连接服务',
    ready: '已有连接就绪',
    to: '/connections',
    hash: 'connector-catalog',
    action: '选择服务',
    description:
      '选择 GitHub、Cloudflare 等服务，填写自己的 Token 或发起 OAuth 授权。保存后自动发现工具；自定义连接需要点击“连接”。',
  },
  {
    title: '为 Agent 选择权限',
    ready: '已有 Agent 分配权限',
    to: '/profiles',
    hash: 'create-profile',
    action: '配置 Agent',
    description:
      '连接成功后点击“给 Agent 授权”，选择已有 Agent 或新建，再勾选允许使用的工具。保存后直接进入客户端接入。',
  },
  {
    title: '复制配置到客户端',
    ready: '接入密钥已就绪',
    to: '/profiles',
    hash: 'agent-configurations',
    action: '获取接入配置',
    description:
      '点击 Agent 旁的“接入”，生成接入密钥后选择客户端并复制配置，再粘贴到客户端的 MCP 设置。密钥只显示一次；请在客户端刷新工具列表确认接通。',
  },
] as const;

export function GettingStarted({
  open: controlledOpen,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
} = {}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Hint content="使用指南">
        <DialogTrigger render={<Button variant="ghost" size="icon" aria-label="使用指南" />}>
          <CircleHelp aria-hidden="true" />
        </DialogTrigger>
      </Hint>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>使用指南</DialogTitle>
        </DialogHeader>
        <ol className="divide-y">
          {setupSteps.map((step, index) => (
            <li key={step.title} className="flex gap-4 py-4 first:pt-2">
              <span
                className="flex size-7 shrink-0 items-center justify-center rounded-full border text-caption text-muted-foreground"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <div className="min-w-0 space-y-2">
                <h3>{step.title}</h3>
                <p className="text-muted-foreground">{step.description}</p>
                <Link
                  to={step.to}
                  hash={step.hash}
                  onClick={() => setOpen(false)}
                  className="inline-flex min-h-8 items-center gap-1 text-caption text-primary hover:underline"
                >
                  {step.action}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </Link>
              </div>
            </li>
          ))}
        </ol>
        <div className="space-y-1 border-t pt-3 text-muted-foreground">
          <Disclosure title="怎么确认可用？">
            <p>
              到工具页选择对应 Agent
              身份，再选工具查看参数。点击“执行”会执行真实操作，请先确认参数。
            </p>
            <Link
              to="/tools"
              onClick={() => setOpen(false)}
              className="inline-flex min-h-8 items-center gap-1 text-primary hover:underline"
            >
              去工具页 <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          </Disclosure>
          <Disclosure title="设备和模型需要配置吗？">
            <p>
              远程服务不用配对设备；只有工具要在另一台电脑上运行时才去“设备”页。连接、授权和工具测试无需模型，内置
              Agent 推理才需要模型配置。
            </p>
          </Disclosure>
          <Disclosure title="想接同一服务的多个账号？">
            <p>在添加连接时再次选择同一服务并分别命名，再为不同 Agent 选择对应连接的工具。</p>
          </Disclosure>
          <Disclosure title="术语表：界面里的词是什么意思？">
            <dl className="glossary-list">
              {glossary.map((entry) => (
                <div key={entry.term}>
                  <dt>{entry.term}</dt>
                  <dd>
                    {entry.meaning}
                    <small>旧称：{entry.was}</small>
                  </dd>
                </div>
              ))}
            </dl>
          </Disclosure>
        </div>
      </DialogContent>
    </Dialog>
  );
}
