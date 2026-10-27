import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight, CircleHelp } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog.js';

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
      '填写 Agent 名称，勾选允许使用的工具，再保存配置。连接服务只代表账号接入，仍需把工具明确分配给 Agent。',
  },
  {
    title: '复制配置到客户端',
    ready: '接入密钥已就绪',
    to: '/profiles',
    hash: 'agent-configurations',
    action: '获取接入配置',
    description:
      '在已创建的 Agent 上点击“生成接入密钥”，再点“复制完整客户端配置”，选择你的客户端并粘贴到它的 MCP 设置中。密钥只在生成时展示。',
  },
] as const;

export function GettingStarted() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" />}>
        <CircleHelp aria-hidden="true" /> 使用指南
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>让 Agent 用上第一个工具</DialogTitle>
          <DialogDescription>
            先接入服务账号，再为 Agent 分配权限，最后连接你的客户端。
          </DialogDescription>
        </DialogHeader>
        <ol className="divide-y">
          {setupSteps.map((step, index) => (
            <li key={step.title} className="flex gap-4 py-5 first:pt-2">
              <span
                className="flex size-7 shrink-0 items-center justify-center rounded-full border text-xs text-muted-foreground"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <div className="min-w-0 space-y-2">
                <h3 className="text-sm font-medium">{step.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{step.description}</p>
                <Link
                  to={step.to}
                  hash={step.hash}
                  onClick={() => setOpen(false)}
                  className="inline-flex min-h-10 items-center gap-1 text-xs text-primary hover:underline"
                >
                  {step.action}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </Link>
              </div>
            </li>
          ))}
        </ol>
        <div className="space-y-2 rounded-lg border bg-muted/30 p-4 text-xs leading-relaxed text-muted-foreground">
          <p>
            <strong className="text-foreground">怎么确认可用？</strong> 到工具目录选择对应 Agent
            身份，再选工具查看参数。点击“执行工具”会执行真实操作，请先确认参数。
          </p>
          <p>
            <strong className="text-foreground">设备和模型需要配置吗？</strong>{' '}
            远程服务不用配对设备；只有工具要在另一台电脑上运行时才去“设备”页。连接、授权和工具测试无需模型，内置
            Agent 推理才需要模型配置。
          </p>
          <p>
            <strong className="text-foreground">想接同一服务的多个账号？</strong>{' '}
            在内置连接器的“管理 / 已连接”菜单中选“添加另一个”，分别命名，再为不同 Agent
            选择对应连接的工具。
          </p>
          <Link
            to="/tools"
            onClick={() => setOpen(false)}
            className="inline-flex min-h-10 items-center gap-1 text-primary hover:underline"
          >
            去工具目录检查 <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}
