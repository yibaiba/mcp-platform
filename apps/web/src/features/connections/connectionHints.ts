import type { Connection, Device } from '../../lib/api.js';

type Target = Pick<Connection, 'adapter' | 'transport' | 'mode' | 'deviceId'> & {
  deviceOffline?: boolean;
  status?: string;
};

/** Where the connection runs, as people say it: "stdio · 我的笔记本（离线）". */
export function connectionLocation(
  connection: Target & { url?: string },
  devices: ReadonlyMap<string, Device>,
) {
  const device = connection.deviceId ? devices.get(connection.deviceId) : undefined;
  const where =
    connection.adapter === 'device'
      ? device
        ? `${device.name}${connection.deviceOffline || !device.online ? '（离线）' : ''}`
        : '未知设备'
      : '平台服务器';
  if (connection.transport === 'stdio') return `stdio · ${where}`;
  if (connection.adapter === 'device')
    return `${connection.url ?? 'HTTP'} · ${where}${connection.mode === 'managed' ? ' · 托管启动' : ''}`;
  return connection.url ?? connection.transport.toUpperCase();
}

/**
 * The next step for a failed save/connect, chosen from what actually went wrong rather than a
 * generic "check address, network and credentials" that does not apply to local commands or
 * an offline device.
 */
export function connectionNextStep(connection: Target, error?: string | null, code?: string) {
  // Server messages for an offline device already name the device and the fix.
  if (error?.includes('重新运行安装命令')) return '';
  // Sandbox refusals (STDIO_SANDBOX_UNAVAILABLE) already say what is missing and how to fix it;
  // the generic "command not found" hint would point at the wrong program.
  if (/STDIO_SANDBOX/.test(`${code ?? ''} ${error ?? ''}`)) return '';
  const text = `${code ?? ''} ${error ?? ''}`;
  if (
    connection.status === 'waiting_authorization' ||
    /OAUTH_REQUIRED|需要授权|未授权账号/.test(text)
  )
    return '打开“授权与账号”完成授权，再连接读取工具列表。';
  if (connection.deviceOffline || /DEVICE_OFFLINE|设备离线|device.*offline/i.test(text))
    return '这台电脑的连接器不在线：在那台电脑重新运行安装命令（「设备」页可复制），上线后再点「重试」。配置已保存。';
  if (/ENOENT|not found|找不到|No such file|executable file not found|spawn/i.test(text))
    return connection.adapter === 'device'
      ? '命令在那台电脑上找不到：确认程序已安装，或在“启动命令”里填写完整路径。'
      : '命令在平台服务器上找不到：确认程序已安装在 server 环境里，或填写完整路径。';
  if (/401|403|Unauthorized|Forbidden|invalid[_ ]token|凭据|credential/i.test(text))
    return '上游拒绝了凭据：检查请求头或环境变量里的 Token，或重新授权。';
  if (
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|getaddrinfo|connection refused|connect failed|socket hang up|network|无法访问|404/i.test(
      text,
    )
  )
    return connection.transport === 'stdio'
      ? '进程启动了但没有完成握手：在那台电脑上手动运行一次命令看看输出，再检查参数。'
      : connection.adapter === 'device'
        ? '这台电脑访问不到这个地址：检查地址和端口，确认本机服务已启动。'
        : '平台访问不到这个地址：检查地址和端口是否正确、服务是否已启动。';
  if (/timeout|timed out|超时/i.test(text))
    return '上游没有在规定时间内响应：确认服务正常运行，必要时在高级设置里调大超时。';
  if (connection.transport === 'stdio')
    return '检查启动命令和参数；可以先在那台电脑上手动运行一次确认能启动。';
  return '检查服务地址、网络和凭据；修改配置后可手动重试连接。';
}
