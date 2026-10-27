import { Code, Field } from '../../components/shared/Controls.js';
import { Input } from '../../components/ui/input.js';
import { authorizationResult } from './authorizationResult.js';
import { Disclosure } from '../../components/shared/Disclosure.js';

export function ConnectionResult({ result }: { result: unknown }) {
  const { url, redirectUrl, authorized, pending } = authorizationResult(result);
  return (
    <div className="space-y-3">
      <p role="status">{authorized ? '已授权' : pending ? '等待供应商授权' : '操作结果已返回'}</p>
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
            在供应商页面确认账号和权限后，将自动返回平台并更新工具目录。
          </p>
        </div>
      ) : null}
      <Disclosure
        title={
          redirectUrl || url || authorized || pending ? '高级授权诊断与回调配置' : '查看返回详情'
        }
      >
        {typeof redirectUrl === 'string' ? (
          <Field label="OAuth 回调地址" hint="预注册应用需填写此地址；独立身份的绑定回调地址不同。">
            <Input value={redirectUrl} readOnly />
          </Field>
        ) : null}
        <Code value={result} />
      </Disclosure>
    </div>
  );
}
