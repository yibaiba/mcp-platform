import { useState } from 'react';
import { connectorTargets } from '@platform/contracts';
import { Code, Feedback, Field } from '../../components/shared/Controls.js';
import { Disclosure } from '../../components/shared/Disclosure.js';
import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import { Button } from '../../components/ui/button.js';
import { installerCommand, type InstallerPlatform } from './installerCommand.js';

export function DeviceInstaller() {
  const [platform, setPlatform] = useState<InstallerPlatform>('unix');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<Error>();
  const command = installerCommand(window.location.origin, platform);
  const localPlatform = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  async function copy() {
    setCopied(false);
    setError(undefined);
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch (error) {
      setError(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return (
    <div className="grid gap-3">
      <Field label="目标电脑系统">
        <SelectControl
          value={platform}
          onValueChange={(value) => {
            setPlatform(value as InstallerPlatform);
            setCopied(false);
            setError(undefined);
          }}
        >
          <SelectItem value="unix">macOS / Linux</SelectItem>
          <SelectItem value="windows">Windows PowerShell</SelectItem>
        </SelectControl>
      </Field>
      <p>在目标电脑的终端执行，会自动下载、校验并启动连接器。无需预装 Go、Node.js 或 connector。</p>
      {localPlatform ? (
        <p className="text-sm text-muted-foreground">
          当前是本机地址，只能连接这台电脑。连接其他电脑时，请通过它可访问的平台 HTTPS
          域名打开此页，再复制命令。
        </p>
      ) : null}
      <Code value={command} />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={() => void copy()}>
          复制安装连接命令
        </Button>
        {copied ? (
          <span role="status" className="text-sm text-primary">
            已复制，请在目标电脑终端执行。
          </span>
        ) : null}
      </div>
      <Feedback error={error ?? null} />
      <small>
        安装到当前用户目录，随后提示输入配对码。保持终端运行；退出后设备离线。再次执行可更新连接器并复用原配置。
      </small>
      <Disclosure title="手动下载连接器">
        <div className="flex flex-wrap gap-3 text-sm">
          {connectorTargets.map((target) => (
            <a
              key={target.filename}
              href={`/api/v1/connector/downloads/${target.filename}`}
              download
            >
              {target.label}
            </a>
          ))}
          <a href="/api/v1/connector/downloads/SHA256SUMS" download>
            SHA-256 校验文件
          </a>
        </div>
        <p>手动下载后运行 connect，并指定平台地址和配置文件路径；详细命令见 docs/connector.md。</p>
      </Disclosure>
    </div>
  );
}
