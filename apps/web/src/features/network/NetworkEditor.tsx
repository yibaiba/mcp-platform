import { SelectControl } from '../../components/shared/SelectControl.js';
import { SelectItem } from '../../components/ui/select.js';
import './network.css';
import { useEffect, useState } from 'react';
import { networkSave, type NetworkView, type NetworkSettings } from '@platform/contracts';
import { Field, Feedback } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { Button } from '../../components/ui/button.js';
import { CheckChoice } from '../../components/shared/CheckChoice.js';
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
type SecretName = keyof NetworkView['secrets'];
const secretFields: Partial<Record<keyof NetworkSettings, { name: SecretName; label: string }>> = {
  httpProxy: { name: 'httpProxyAuth', label: 'HTTP 代理账号:密码' },
  httpsProxy: { name: 'httpsProxyAuth', label: 'HTTPS 代理账号:密码' },
  githubApi: { name: 'githubApiToken', label: 'GitHub API 独立令牌' },
  githubDownload: { name: 'githubDownloadToken', label: 'GitHub 下载独立令牌' },
  githubClone: { name: 'githubCloneToken', label: 'GitHub Git 独立令牌' },
};
const sections = [
  {
    title: '通用代理',
    description: '平台请求及新建子进程使用以下代理。NO_PROXY 中的地址直接连接。',
    keys: ['httpProxy', 'httpsProxy', 'noProxy'],
  },
  {
    title: 'npm / Python 安装源',
    description: '更新查询和安装使用同一来源，私有包源及其凭证始终保留。',
    keys: ['npmRegistry', 'pythonIndex'],
  },
  {
    title: 'GitHub 加速',
    description: 'API、文件下载和 Git 克隆独立配置；第三方端点不会自动收到原 GitHub 认证信息。',
    keys: ['githubApi', 'githubDownload', 'githubClone'],
  },
];
type Check = { kind: string; url: string; ok: boolean; detail: string };
export function NetworkEditor({
  initial,
  save,
  check,
  local = false,
  onDirtyChange,
}: {
  initial: NetworkView;
  save: (value: unknown) => Promise<NetworkView>;
  check: () => Promise<Check[]>;
  local?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [current, setCurrent] = useState(initial);
  const [settings, setSettings] = useState(initial.settings);
  const [edits, setEdits] = useState<
    Partial<Record<SecretName, { action: 'keep' | 'replace' | 'clear'; value?: string }>>
  >({});
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [results, setResults] = useState<Check[]>([]);
  const clearFeedback = () => {
    setNotice('');
    setError(null);
  };
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
  const dirty =
    JSON.stringify(settings) !== JSON.stringify(current.settings) ||
    Object.values(edits).some((edit) => edit.action !== 'keep');
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
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
      className="form network-editor"
      onChange={clearFeedback}
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
      {sections.map((section) => (
        <section className="network-section" key={section.title}>
          <h3>{section.title}</h3>
          <p className="text-muted-foreground">{section.description}</p>
          <div className="form-grid">
            {fields
              .filter(([key]) => section.keys.includes(key))
              .map(([key, label, hint]) => {
                const secret = secretFields[key];
                return (
                  <div className="network-setting" key={key}>
                    <Field label={label} hint={hint}>
                      <Input
                        disabled={busy}
                        value={settings[key]}
                        autoComplete="off"
                        onChange={(event) =>
                          setSettings({ ...settings, [key]: event.target.value })
                        }
                      />
                    </Field>
                    {secret ? (
                      <NetworkSecret
                        name={secret.name}
                        label={secret.label}
                        busy={busy}
                        saved={current.secrets[secret.name]}
                        edit={edits[secret.name]}
                        onChange={(edit) => {
                          clearFeedback();
                          setEdits({ ...edits, [secret.name]: edit });
                        }}
                      />
                    ) : null}
                    {['githubDownload', 'githubClone'].includes(key) && settings[key] ? (
                      <p className="url-preview">
                        {key === 'githubDownload' ? '下载预览' : 'Git 预览'}：
                        {preview(settings[key])}
                      </p>
                    ) : null}
                  </div>
                );
              })}
          </div>
          {section.keys.includes('npmRegistry') ? (
            <div className="network-source-toggle">
              <CheckChoice
                disabled={busy}
                checked={settings.replacePublicSources}
                onCheckedChange={(checked) => {
                  clearFeedback();
                  setSettings({ ...settings, replacePublicSources: checked });
                }}
              >
                将明确声明的官方公共源替换为镜像（私有源保留）
              </CheckChoice>
            </div>
          ) : null}
        </section>
      ))}
      <Feedback error={error} />
      {notice ? <p role="status">{notice}</p> : null}
      <div className="network-save-bar">
        <p role="status" className="draft-state">
          {dirty ? '有未保存的网络设置' : '网络设置与已保存版本一致'}
        </p>
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
      </div>
      <div aria-live="polite" className="network-check-results">
        {results.map((result) => (
          <p className="rounded border p-3" key={result.kind}>
            {result.kind}：{result.ok ? '成功' : '失败'} · {result.detail}
            <br />
            {result.url}
          </p>
        ))}
      </div>
    </form>
  );
}

type SecretEdit = { action: 'keep' | 'replace' | 'clear'; value?: string };
function NetworkSecret({
  name,
  label,
  saved,
  busy,
  edit,
  onChange,
}: {
  name: SecretName;
  label: string;
  saved: boolean;
  busy: boolean;
  edit?: SecretEdit;
  onChange: (edit: SecretEdit) => void;
}) {
  return (
    <div className="network-secret">
      <Field
        label={`${label}操作`}
        hint={saved ? '已保存，无法回读；可保留、更换或清除。' : '尚未设置'}
      >
        <SelectControl
          disabled={busy}
          value={edit?.action ?? 'keep'}
          onValueChange={(action) => onChange({ action: action as SecretEdit['action'] })}
        >
          <SelectItem value="keep">保留</SelectItem>
          <SelectItem value="replace">更换</SelectItem>
          <SelectItem value="clear">清除</SelectItem>
        </SelectControl>
      </Field>
      {edit?.action === 'replace' ? (
        <Field label={label}>
          <Input
            name={name}
            type="password"
            disabled={busy}
            autoComplete="new-password"
            value={edit.value ?? ''}
            required
            onChange={(event) => onChange({ action: 'replace', value: event.target.value })}
          />
        </Field>
      ) : null}
    </div>
  );
}
