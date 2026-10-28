import { PostMessageTransport, type AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';

type ProxyOptions = {
  iframe: HTMLIFrameElement;
  bridge: AppBridge;
  sandboxOrigin: string;
  onError: (error: unknown) => void;
};

export function mountSandboxProxy(options: ProxyOptions) {
  const { iframe, bridge, onError } = options;
  const load = new AbortController();
  let connected = false;
  const ready = () => {
    if (!iframe.contentWindow || connected) return;
    connected = true;
    const transport = proxyTransport(iframe.contentWindow, onError);
    void bridge.connect(transport).catch(onError);
    iframe.contentWindow.postMessage({ jsonrpc: '2.0', method: 'platform/proxy-check' }, '*');
  };
  void fetch(
    `${options.sandboxOrigin}/_apps/sandbox?parent=${encodeURIComponent(window.location.origin)}`,
    { credentials: 'omit', signal: load.signal },
  )
    .then(async (response) => {
      if (!response.ok) throw new Error(`App proxy load failed: ${response.status}`);
      const html = await response.text();
      if (load.signal.aborted) return;
      iframe.addEventListener('load', ready);
      // data: keeps the trusted proxy opaque even though its HTML shares the public endpoint.
      iframe.src = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    })
    .catch((error: unknown) => {
      if (!load.signal.aborted) onError(error);
    });
  return () => {
    load.abort();
    iframe.removeEventListener('load', ready);
  };
}

function proxyTransport(target: Window, onError: ProxyOptions['onError']) {
  const transport = new PostMessageTransport(target, target);
  const start = transport.start.bind(transport);
  const close = transport.close.bind(transport);
  // The SDK pins the window; also require its opaque origin, not just any null-origin frame.
  const filter = (event: MessageEvent) => {
    if (event.source !== target) return;
    if (event.origin !== 'null') {
      event.stopImmediatePropagation();
      return;
    }
    if (event.data?.method === 'platform/proxy-error')
      onError(new Error(String(event.data.params?.message)));
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
    target.postMessage(message, '*');
  };
  return transport;
}
