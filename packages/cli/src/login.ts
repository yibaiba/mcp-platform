import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { HttpClient } from './httpClient.js';
import { CliError } from './errors.js';
export async function login(input: {
  client: HttpClient;
  readOnly: boolean;
  signal: AbortSignal;
  open: (url: string) => Promise<void>;
  diagnostic: (message: string) => void;
}) {
  const { config, name, environment } = await input.client.environment();
  const state = randomBytes(32).toString('base64url'),
    verifier = randomBytes(32).toString('base64url');
  const hash = (value: string) => createHash('sha256').update(value).digest();
  let callback = '',
    submitted = false;
  let resolve!: () => void, reject!: (error: unknown) => void;
  const finished = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', callback);
    if (
      request.method !== 'GET' ||
      url.pathname !== '/callback' ||
      request.headers.host !== new URL(callback).host ||
      !timingSafeEqual(hash(url.searchParams.get('state') ?? ''), hash(state))
    ) {
      response.writeHead(400).end('Invalid login callback');
      return;
    }
    if (submitted) {
      response.writeHead(409).end('Callback already submitted');
      return;
    }
    submitted = true;
    void (async () => {
      if (url.searchParams.has('error')) throw new CliError('浏览器已拒绝 CLI 授权', 3);
      const code = url.searchParams.get('code');
      if (!code) throw new CliError('登录回调缺少授权码', 3);
      const token = await input.client.exchange(environment.url, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: callback,
        code_verifier: verifier,
      });
      await input.client.saveTokens({ config, name, token });
      response
        .writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        .end('CLI 登录成功，可以关闭此页面。');
      resolve();
    })().catch((error) => {
      response.writeHead(400).end('CLI login failed; see terminal.');
      reject(error);
    });
  });
  const abort = () => reject(new CliError('登录已取消', 3));
  input.signal.addEventListener('abort', abort, { once: true });
  // Observe cancellation even if the browser launcher has not returned yet.
  void finished.catch(() => {});
  try {
    await new Promise<void>((a, b) => {
      server.once('error', b);
      server.listen(0, '127.0.0.1', a);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new CliError('无法绑定本机登录回调端口', 4);
    callback = `http://127.0.0.1:${address.port}/callback`;
    const url = new URL('/api/v1/cli/authorize', environment.url);
    url.search = new URLSearchParams({
      redirect_uri: callback,
      state,
      code_challenge: hash(verifier).toString('base64url'),
      code_challenge_method: 'S256',
      scope: input.readOnly ? 'management:read' : 'management:read management:write',
    }).toString();
    input.diagnostic(`请在浏览器确认平台地址、账号和权限：${url}`);
    if (input.signal.aborted) abort();
    await input.open(url.toString());
    await finished;
    return { loggedIn: true, environment: name, platform: environment.url };
  } finally {
    input.signal.removeEventListener('abort', abort);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
