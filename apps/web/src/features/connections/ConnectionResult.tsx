import { Code, Field } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { authorizationResult } from './authorizationResult.js';

export function ConnectionResult({ result }: { result: unknown }) {
  const { url, redirectUrl } = authorizationResult(result);
  return (
    <div className="space-y-3">
      {url ? (
        <div className="space-y-2">
          <a
            href={url.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-10 items-center text-primary underline underline-offset-4 focus-visible:outline focus-visible:outline-ring"
          >
            打开供应商授权页面（{url.host}，新窗口）
          </a>
          <p className="text-sm text-muted-foreground">
            确认供应商列出的账号和权限；授权完成后返回此页，点击“连接 / 刷新目录”。
          </p>
        </div>
      ) : null}
      {typeof redirectUrl === 'string' ? (
        <Field label="OAuth 回调地址" hint="预注册应用需填写此地址；独立身份的绑定回调地址不同。">
          <Input value={redirectUrl} readOnly />
        </Field>
      ) : null}
      <Code value={result} />
    </div>
  );
}
