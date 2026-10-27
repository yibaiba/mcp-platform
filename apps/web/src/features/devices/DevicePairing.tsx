import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Card } from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import { SelectItem } from '../../components/ui/select.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { Code, date, Field, Form, value } from '../../components/shared/Controls.js';
import { api, json } from '../../lib/api.js';

export function DevicePairing() {
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string }>();
  const [platform, setPlatform] = useState('unix');
  const binary = platform === 'windows' ? '.\\connector.exe' : './connector';
  const command = `${binary} connect --server ${JSON.stringify(window.location.origin)} --config connector.json`;
  return (
    <div className="overview-grid">
      <Card className="panel padded">
        <h2>1. 连接这台电脑</h2>
        <p>在要控制的电脑上运行连接器，首次粘贴配对码后会直接连接。</p>
        <Form
          label="生成一次性配对码"
          submit={async (data) =>
            setPairing(
              await api('/devices/pairings', {
                method: 'POST',
                body: json({ name: value(data, 'name') }),
              }),
            )
          }
        >
          <Field label="电脑名称">
            <Input name="name" required placeholder="例如：家里的 Mac" />
          </Field>
        </Form>
        {pairing ? (
          <div className="result">
            <Field label="目标电脑系统">
              <SelectControl value={platform} onValueChange={setPlatform}>
                <SelectItem value="unix">macOS / Linux</SelectItem>
                <SelectItem value="windows">Windows PowerShell</SelectItem>
              </SelectControl>
            </Field>
            <p>
              将对应系统的可执行文件放在当前目录，命名为 connector（Windows 为
              connector.exe），运行：
            </p>
            <Code value={command} />
            <p>终端出现提示时粘贴此配对码：</p>
            <Code value={pairing.code} />
            <small>有效期至 {date(pairing.expiresAt)}，仅可使用一次。</small>
            <p>以后运行同一条命令，无需再配对。保持终端运行；退出后电脑会离线。</p>
          </div>
        ) : null}
        <Disclosure title="如何获取连接器？">
          <p>目前需要从项目源码构建，尚未提供 npm 一键安装包。</p>
          <Code value="pnpm connector:build" />
          <p>
            在 connector/bin 中选择目标系统和架构的文件，复制到目标电脑。详细安装与登录自启动见
            docs/connector.md。
          </p>
        </Disclosure>
      </Card>
      <Card className="panel padded">
        <h2>2. 添加本机工具</h2>
        <p>电脑在线后，点击下方“添加本机工具”。同一台电脑可以分别添加这三类 MCP：</p>
        <ul className="list-disc space-y-3 pl-5 text-sm">
          <li>
            <strong>文件和终端</strong>：读写文件、执行命令、管理进程。
          </li>
          <li>
            <strong>浏览器</strong>：访问网页、点击、填写表单和网页截图。
          </li>
          <li>
            <strong>桌面</strong>：查看屏幕、操作鼠标键盘及本机应用；需要兼容当前系统的桌面 MCP。
          </li>
        </ul>
        <p>设备在线只代表通道已接通。工具是否可用，要以连接发现和实际调用结果为准。</p>
        <Disclosure title="桌面和浏览器需要准备什么？">
          <p>
            桌面 MCP 需要用户登录图形会话；macOS 需按工具说明授予辅助功能和屏幕录制权限。浏览器 MCP
            控制的浏览器与是否复用登录状态由该工具配置决定。
          </p>
          <p>
            连接器负责启动和转发
            MCP，尚未内置安装这三类工具。命令、依赖或系统权限失败会直接显示错误。
          </p>
        </Disclosure>
        <h2>3. 选择谁可以使用</h2>
        <p>
          到 <Link to="/connections">MCP 连接</Link> 发现工具，再到{' '}
          <Link to="/profiles">Agent 配置</Link> 勾选权限。外部客户端继续使用该 Agent 的同一个 MCP
          地址。
        </p>
      </Card>
    </div>
  );
}
