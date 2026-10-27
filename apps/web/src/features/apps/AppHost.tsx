import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { api, json } from '../../lib/api.js';
import { Button } from '../../components/ui/button.js';
import { Feedback } from '../../components/shared/Controls.js';
import { Textarea } from '../../components/ui/textarea.js';
type View = {
  sandboxOrigin: string;
  arguments: Record<string, unknown>;
  result: Parameters<AppBridge['sendToolResult']>[0];
  resource: {
    contents: {
      text?: string;
      blob?: string;
      mimeType?: string;
      _meta?: {
        ui?: {
          csp?: Parameters<AppBridge['sendSandboxResourceReady']>[0]['csp'];
          permissions?: Record<string, unknown>;
        };
      };
    }[];
  };
};
export function AppHost({
  sessionId,
  onSend,
}: {
  sessionId: string;
  onSend?: (text: string) => Promise<unknown>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<AppBridge | null>(null);
  const teardown = useRef<(() => Promise<void>) | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [height, setHeight] = useState(400);
  const [fullscreen, setFullscreen] = useState(false);
  const [message, setMessage] = useState('');
  const [closed, setClosed] = useState(false);
  const query = useQuery({
    queryKey: ['app', sessionId],
    queryFn: () => api<View>(`/apps/${sessionId}`),
    retry: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (!query.data || closed) return;
    const data = query.data;
    const iframe = frame.current;
    if (!iframe) return;
    const failure = (error: unknown) =>
      setError(error instanceof Error ? error : new Error(String(error)));
    const instance = new AppBridge(
      null,
      { name: 'MCP Platform', version: '0.1.0' },
      {
        serverTools: {},
        serverResources: {},
        openLinks: {},
        ...(onSend ? { message: {}, updateModelContext: {} } : {}),
      },
      {
        hostContext: {
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
          displayMode: 'inline',
          availableDisplayModes: ['inline', 'fullscreen'],
        },
      },
    );
    bridge.current = instance;
    let teardownPromise: Promise<void> | undefined;
    const dispose = () => {
      teardownPromise ??= instance
        .teardownResource({}, { timeout: 1000 })
        .then(() => undefined)
        .finally(() => instance.close());
      return teardownPromise;
    };
    teardown.current = dispose;
    const endpoint = `/apps/${sessionId}`;
    const theme = new MutationObserver(() =>
      instance.setHostContext({
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      }),
    );
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    instance.onrequestteardown = () => {
      void dispose()
        .catch(failure)
        .finally(() => {
          void api(endpoint, { method: 'DELETE' })
            .then(() => setClosed(true))
            .catch(failure);
        });
    };
    let resourceSent = false;
    instance.onsandboxready = () => {
      if (resourceSent) return;
      resourceSent = true;
      const resource = data.resource.contents.find(
        (item) => item.mimeType === 'text/html;profile=mcp-app',
      );
      if (!resource || (resource.text === undefined && resource.blob === undefined)) {
        failure(new Error('UI 资源没有声明 MCP App HTML'));
        return;
      }
      void instance
        .sendSandboxResourceReady({
          html:
            resource.text ??
            new TextDecoder().decode(Uint8Array.from(atob(resource.blob!), (c) => c.charCodeAt(0))),
          csp: resource._meta?.ui?.csp,
          sandbox: 'allow-scripts allow-forms',
        })
        .catch(failure);
    };
    instance.oninitialized = () => {
      void instance
        .sendToolInput({ arguments: data.arguments })
        .then(() => instance.sendToolResult(data.result))
        .catch(failure);
    };
    // SDK request metadata belongs to the AppBridge transport, not the management DTO.
    instance.oncalltool = ({ name, arguments: args }, extra) =>
      api(`${endpoint}/call`, {
        method: 'POST',
        body: json({ name, arguments: args }),
        signal: extra.mcpReq.signal,
      });
    instance.onreadresource = ({ uri }, extra) =>
      api(`${endpoint}/read`, {
        method: 'POST',
        body: json({ uri }),
        signal: extra.mcpReq.signal,
      });
    instance.onsizechange = (params) => {
      if (params.height) setHeight(params.height);
    };
    instance.onrequestdisplaymode = async ({ mode }) => {
      setFullscreen(mode === 'fullscreen');
      return { mode };
    };
    instance.onopenlink = async ({ url }) => {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('外部地址协议无效');
      if (!window.confirm(`确认打开 ${parsed.origin}？`)) return { isError: true };
      window.open(parsed.href, '_blank', 'noopener,noreferrer');
      return {};
    };
    if (onSend) {
      instance.onmessage = async (params) => {
        await api(`${endpoint}/message`, { method: 'POST', body: json(params) });
        setMessage(
          params.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n'),
        );
        return {};
      };
      instance.onupdatemodelcontext = async (params) => {
        await api(`${endpoint}/context`, { method: 'POST', body: json(params) });
        return {};
      };
    }
    let connected = false;
    const ready = () => {
      if (!iframe.contentWindow || connected) return;
      connected = true;
      const transport = new PostMessageTransport(iframe.contentWindow, iframe.contentWindow);
      const origin = new URL(data.sandboxOrigin).origin;
      // The official transport verifies the window; this wrapper also pins the proxy origin.
      const start = transport.start.bind(transport);
      const close = transport.close.bind(transport);
      const filter = (event: MessageEvent) => {
        if (event.source === iframe.contentWindow && event.origin !== origin)
          event.stopImmediatePropagation();
        if (
          event.source === iframe.contentWindow &&
          event.origin === origin &&
          event.data?.method === 'platform/proxy-error'
        )
          failure(new Error(String(event.data.params?.message)));
      };
      transport.start = async () => {
        window.addEventListener('message', filter, true);
        await start();
      };
      transport.close = async () => {
        window.removeEventListener('message', filter, true);
        await close();
      };
      transport.send = async (message) => {
        iframe.contentWindow?.postMessage(message, origin);
      };
      void instance.connect(transport).catch(failure);
      iframe.contentWindow.postMessage({ jsonrpc: '2.0', method: 'platform/proxy-check' }, origin);
    };
    iframe.addEventListener('load', ready);
    iframe.src = `${data.sandboxOrigin}/sandbox?parent=${encodeURIComponent(window.location.origin)}`;
    return () => {
      iframe.removeEventListener('load', ready);
      theme.disconnect();
      bridge.current = null;
      teardown.current = null;
      void dispose().catch(failure);
      void api(endpoint, { method: 'DELETE' }).catch((error: unknown) =>
        console.error('App session cleanup failed', error),
      );
    };
  }, [query.data, sessionId, closed, onSend]);
  if (closed)
    return (
      <div>
        <Feedback error={error} />
        <p role="status">App 视图已结束；不会重放工具恢复。</p>
      </div>
    );
  const data = query.data;
  return (
    <div className={fullscreen ? 'fixed inset-0 z-50 bg-background p-4 overflow-auto' : ''}>
      <Feedback error={error ?? query.error} />
      {data?.resource.contents.some(
        (item) => Object.keys(item._meta?.ui?.permissions ?? {}).length > 0,
      ) ? (
        <p role="status">
          此 App
          申请了可选浏览器权限。本宿主未授予摄像头、麦克风、定位或剪贴板权限，相关功能不可用。
        </p>
      ) : null}
      <div className="row-actions">
        <Button
          variant="outline"
          onClick={() => {
            bridge.current?.setHostContext({ displayMode: fullscreen ? 'inline' : 'fullscreen' });
            setFullscreen(!fullscreen);
          }}
        >
          {fullscreen ? '退出全屏' : '全屏'}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            void (async () => {
              await bridge.current?.sendToolCancelled({ reason: '用户关闭视图' });
              await teardown.current?.();
            })()
              .catch(setError)
              .finally(() => {
                void api(`/apps/${sessionId}`, { method: 'DELETE' })
                  .then(() => setClosed(true))
                  .catch(setError);
              });
          }}
        >
          关闭视图
        </Button>
      </div>
      {data ? (
        <iframe
          ref={frame}
          title="MCP App"
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          style={{ width: '100%', height: fullscreen ? '80vh' : height, border: 0 }}
        />
      ) : (
        <p role="status">读取 App 资源…</p>
      )}
      {message && onSend ? (
        <div>
          <p>App 请求发送消息，请确认内容后发送。</p>
          <Textarea
            aria-label="待发送消息"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
          <Button
            onClick={() =>
              void onSend(message)
                .then(() => setMessage(''))
                .catch(setError)
            }
          >
            发送并执行
          </Button>
        </div>
      ) : null}
    </div>
  );
}
