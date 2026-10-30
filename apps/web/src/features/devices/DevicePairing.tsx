import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Input } from '../../components/ui/input.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { Code, date, Field, Form, value } from '../../components/shared/Controls.js';
import { api, json } from '../../lib/api.js';
import { DeviceInstaller } from './DeviceInstaller.js';

/** Steps for pairing a new computer; lives in the 「添加设备」 drawer. */
export function DevicePairing() {
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string }>();
  return (
    <ol className="pairing-steps">
      <li>
        <h3>给电脑起个名字并生成配对码</h3>
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
            <p>终端提示时粘贴此配对码：</p>
            <Code value={pairing.code} />
            <small>有效期至 {date(pairing.expiresAt)}，仅可使用一次。</small>
          </div>
        ) : null}
      </li>
      <li>
        <h3>在那台电脑上运行安装命令</h3>
        <DeviceInstaller />
        <small>以后再运行同一条命令无需重新配对。</small>
      </li>
      <li>
        <h3>添加本机工具并授权</h3>
        <p>
          设备在线后，在列表中点「添加本机工具」；再到 <Link to="/profiles">Agent</Link> 勾选权限。
        </p>
        <Disclosure title="文件、浏览器、桌面工具需要准备什么？">
          <p>
            同一台电脑可以分别添加文件和终端、浏览器、桌面三类 MCP。连接器只负责启动和转发
            MCP，不内置安装这些工具；命令、依赖或系统权限失败会直接显示错误。
          </p>
          <p>
            桌面 MCP 需要登录的图形会话；macOS
            需授予辅助功能和屏幕录制权限。浏览器是否复用登录状态由该工具配置决定。
          </p>
          <p>设备在线只代表通道已接通，工具是否可用以实际调用结果为准。</p>
        </Disclosure>
      </li>
    </ol>
  );
}
