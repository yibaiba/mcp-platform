import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SshAccessView } from '@platform/contracts';
import { api, json, type Connection } from '../../lib/api.js';
import { Action, Empty, Feedback, Status } from '../../components/shared/Controls.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { Card } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';
import { SshAccessForm } from './SshAccessForm.js';
export default function SshAccesses() {
  const [editing, setEditing] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const accesses = useQuery({
    queryKey: ['ssh-accesses'],
    queryFn: () => api<SshAccessView[]>('/ssh-accesses'),
    refetchInterval: 15_000,
  });
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<Connection[]>('/connections'),
  });
  const eligible =
    connections.data?.filter(
      (c) =>
        c.adapter === 'direct' &&
        c.source === 'mcp' &&
        c.mode === 'existing' &&
        c.transport !== 'stdio',
    ) ?? [];
  return (
    <Card className="panel padded">
      <div className="panel-heading">
        <h2>SSH 转发接入</h2>
        <Button onClick={() => setEditing(editing === 'new' ? undefined : 'new')}>
          新增 SSH 接入
        </Button>
      </div>
      <p>让已有 HTTP MCP 通过 SSH 反向隧道接入平台。设备仍负责启动 MCP 服务。</p>
      <Feedback error={accesses.error ?? connections.error} />
      {editing === 'new' ? (
        <SshAccessForm connections={eligible} done={() => setEditing(undefined)} />
      ) : null}
      {accesses.data?.length === 0 ? <Empty>尚未配置 SSH 接入。</Empty> : null}
      {accesses.data?.map((item) => (
        <section className="connection-row" key={item.id}>
          <div className="row">
            <div className="grow">
              <strong>{item.name}</strong>
              <small>
                {item.platform} · {item.ssh.username}@{item.ssh.host}:{item.ssh.port}
              </small>
            </div>
            <span>隧道状态未上报</span>
          </div>
          <p>实际 SSH 状态请查看设备上的 connection.log；以下是平台 MCP 连接状态。</p>
          {item.bindings.length === 0 ? (
            <p role="alert">原 MCP 连接已删除，请编辑并绑定新连接。</p>
          ) : null}
          {item.services.map((service) => (
            <div key={service.connectionId} className="row">
              <strong>{service.name}</strong>
              <Status value={service.status} />
              <Feedback
                error={
                  service.configurationError || service.error
                    ? new Error(service.configurationError ?? service.error!)
                    : null
                }
              />
              <Action
                action={() =>
                  api(`/connections/${service.connectionId}/discover`, { method: 'POST' })
                }
              >
                发现 MCP
              </Action>
            </div>
          ))}
          <div className="row-actions">
            <Button
              variant="outline"
              onClick={() => setEditing(editing === item.id ? undefined : item.id)}
            >
              编辑接入
            </Button>
            <Action
              action={async () => {
                const response = await fetch(`/api/v1/ssh-accesses/${item.id}/windows-bundle`);
                if (!response.ok) throw new Error((await response.json()).error);
                const url = URL.createObjectURL(await response.blob());
                const link = document.createElement('a');
                link.href = url;
                link.download = `mcp-platform-ssh-${item.id}.zip`;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              下载 Windows 连接包
            </Action>
            <Button variant="outline" onClick={() => setDeleting(item.id)}>
              删除接入
            </Button>
          </div>
          {deleting === item.id ? (
            <div role="group" aria-label="确认删除 SSH 接入">
              <p>
                删除只移除平台记录。请在设备上停止隧道或卸载启动任务；SSH 密钥和 MCP 连接仍保留。
              </p>
              <Action
                danger
                confirmed
                action={async () => {
                  await api(`/ssh-accesses/${item.id}`, {
                    method: 'DELETE',
                    body: json({ revision: item.revision }),
                  });
                  setDeleting(undefined);
                }}
              >
                确认删除记录
              </Action>
              <Button variant="outline" onClick={() => setDeleting(undefined)}>
                取消删除
              </Button>
            </div>
          ) : null}
          {editing === item.id ? (
            <SshAccessForm
              current={item}
              connections={eligible}
              done={() => setEditing(undefined)}
            />
          ) : null}
        </section>
      ))}
      <Disclosure title="启动与排查">
        <p>
          Windows 解压下载包，在 PowerShell 运行 .\Connect-McpPlatform.ps1
          -Interactive，核对主机指纹后验证 MCP。运行 .\Install-Startup.ps1
          可注册当前用户登录启动；.\Uninstall-Startup.ps1 停止并卸载。
        </p>
        <p>
          其他系统可使用 OpenSSH 的 -R 127.0.0.1:远端端口:127.0.0.1:本机端口。SSH 服务端设置
          GatewayPorts no；Docker 部署需要让 SSH 监听端口与平台进程共享网络空间。
        </p>
        <p>
          隧道重连不会重放工具调用。平台 MCP 自动恢复需在连接设置中单独开启；SSH
          接入不授予设备文件管理或 Skills 安装权限。
        </p>
      </Disclosure>
    </Card>
  );
}
