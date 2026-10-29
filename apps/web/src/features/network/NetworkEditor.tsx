import { useState } from 'react';
import {
  networkSave,
  networkSecretNames,
  type NetworkView,
  type NetworkSettings,
} from '@platform/contracts';
import { Field, Feedback } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
const fields: [keyof Omit<NetworkSettings, 'replacePublicSources'>, string, string][] = [
  ['httpProxy', 'HTTP 代理', 'http://127.0.0.1:7890'],
  ['httpsProxy', 'HTTPS 请求代理', '留空使用 HTTP 代理'],
  ['noProxy', 'NO_PROXY', 'localhost,127.0.0.1,[::1],.example.com:443'],
  ['npmRegistry', 'npm 公共镜像', '留空使用原声明或工具默认源'],
  ['pythonIndex', 'Python 公共索引', 'https://镜像域名/simple/'],
  ['githubApi', 'GitHub API 基地址', '留空使用 api.github.com'],
  ['githubDownload', 'GitHub 下载模板', 'https://加速域名/{url} 或 {encodedUrl}'],
  ['githubClone', 'GitHub Git 克隆模板', 'https://加速域名/{owner}/{repo}.git'],
];
const secretLabels = [
  'HTTP 代理账号:密码',
  'HTTPS 代理账号:密码',
  'GitHub API 独立令牌',
  'GitHub 下载独立令牌',
  'GitHub Git 独立令牌',
];
type Check = { kind: string; url: string; ok: boolean; detail: string };
export function NetworkEditor({
  initial,
  save,
  check,
  local = false,
}: {
  initial: NetworkView;
  save: (value: unknown) => Promise<NetworkView>;
  check: () => Promise<Check[]>;
  local?: boolean;
}) {
  const [current, setCurrent] = useState(initial);
  const [settings, setSettings] = useState(initial.settings);
  const [edits, setEdits] = useState<
    Record<string, { action: 'keep' | 'replace' | 'clear'; value?: string }>
  >({});
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [results, setResults] = useState<Check[]>([]);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setBusy(false);
    }
  };
  const preview = (template: string) =>
    template
      .replaceAll(
        '{url}',
        'https://github.com/yibaiba/mcp-platform/archive/0123456789abcdef.zip?download=1',
      )
      .replaceAll(
        '{encodedUrl}',
        encodeURIComponent(
          'https://github.com/yibaiba/mcp-platform/archive/0123456789abcdef.zip?download=1',
        ),
      )
      .replaceAll('{owner}', 'yibaiba')
      .replaceAll('{repo}', 'mcp-platform');
  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        void act(async () => {
          const saved = await save(
            networkSave.parse({ revision: current.revision, settings, secrets: edits }),
          );
          setCurrent(saved);
          setSettings(saved.settings);
          setEdits({});
          setResults([]);
          setNotice(
            local
              ? '已保存。平台通道请断开后重新连接；新请求和新进程使用新设置，已有 MCP 进程保持运行。'
              : '已保存。后续请求和新建会话生效；已有 MCP、Pi 任务和子进程保持运行。',
          );
        });
      }}
    >
      <p>
        {local ? '仅作用于这台设备，凭证不会上传到平台。' : '仅作用于平台，不下发到设备。'}
        代理失败会明确报错；包源失败不会自动切换官方源。
      </p>
      <div className="form-grid">
        {fields.map(([key, label, hint]) => (
          <Field key={key} label={label} hint={hint}>
            <Input
              value={settings[key]}
              onChange={(event) => setSettings({ ...settings, [key]: event.target.value })}
              autoComplete="off"
            />
          </Field>
        ))}
      </div>
      <label>
        <input
          type="checkbox"
          checked={settings.replacePublicSources}
          onChange={(event) =>
            setSettings({ ...settings, replacePublicSources: event.target.checked })
          }
        />{' '}
        将明确声明的官方公共源替换为镜像（私有源保留）
      </label>
      <div className="form-grid">
        {networkSecretNames.map((name, index) => (
          <Field
            key={name}
            label={secretLabels[index]!}
            hint={current.secrets[name] ? '已保存，无法回读；可保留、更换或清除。' : '尚未设置'}
          >
            <div>
              <select
                aria-label={`${secretLabels[index]}操作`}
                value={edits[name]?.action ?? 'keep'}
                onChange={(event) =>
                  setEdits({
                    ...edits,
                    [name]: { action: event.target.value as 'keep' | 'replace' | 'clear' },
                  })
                }
              >
                <option value="keep">保留</option>
                <option value="replace">更换</option>
                <option value="clear">清除</option>
              </select>
              {edits[name]?.action === 'replace' ? (
                <Input
                  aria-label={secretLabels[index]}
                  type="password"
                  autoComplete="new-password"
                  value={edits[name]?.value ?? ''}
                  onChange={(event) =>
                    setEdits({ ...edits, [name]: { action: 'replace', value: event.target.value } })
                  }
                  required
                />
              ) : null}
            </div>
          </Field>
        ))}
      </div>
      <p>GitHub 第三方端点不会自动收到原 GitHub 认证信息。需要认证时，请填写对应的独立令牌。</p>
      {settings.githubDownload || settings.githubClone ? (
        <div style={{ overflowWrap: 'anywhere' }} aria-label="地址预览">
          {settings.githubDownload ? <p>下载预览：{preview(settings.githubDownload)}</p> : null}
          {settings.githubClone ? <p>Git 预览：{preview(settings.githubClone)}</p> : null}
        </div>
      ) : null}
      <Feedback error={error} />
      <p role="status">{notice}</p>
      <div className="actions">
        <Button type="submit" disabled={busy}>
          {busy ? '处理中…' : '保存网络设置'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              setResults(await check());
            })
          }
        >
          检查已保存设置的连通性
        </Button>
      </div>
      <div aria-live="polite">
        {results.map((result) => (
          <p key={result.kind} style={{ overflowWrap: 'anywhere' }}>
            {result.kind}：{result.ok ? '成功' : '失败'} · {result.detail}
            <br />
            {result.url}
          </p>
        ))}
      </div>
    </form>
  );
}
