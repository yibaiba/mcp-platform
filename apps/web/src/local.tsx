import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { LocalManager } from './features/local/LocalManager.js';
import { localApi, type ManagementApi } from './features/local/api.js';
import './features/local/local.css';
function App() {
  const [api, setApi] = useState<ManagementApi>();
  const [error, setError] = useState('');
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('open');
    history.replaceState(null, '', '/');
    void fetch(
      '/local-api/v1/session',
      token
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
          }
        : undefined,
    )
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error);
        setApi(localApi(value.csrf));
      })
      .catch((error: Error) => setError(error.message));
  }, []);
  return (
    <main className="local-shell">
      <header>
        <span className="local-eyebrow">MCP PLATFORM · LOCAL</span>
        <h1>本机 MCP 与 Skills</h1>
        <p>本地资源随时可用。选择纳入同步后，连接平台时自动核对修改。</p>
      </header>
      {error ? (
        <p role="alert" className="local-error">
          {error}。请使用连接器终端输出的一次性链接打开。
        </p>
      ) : api ? (
        <LocalManager api={api} />
      ) : (
        <p role="status">正在建立本机会话…</p>
      )}
    </main>
  );
}
const queries = new QueryClient();
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queries}>
    <App />
  </QueryClientProvider>,
);
