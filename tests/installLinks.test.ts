import { expect, test } from 'vitest';
import {
  exportClient,
  installLinks,
} from '../apps/server/src/modules/agent-profiles/clientExport.js';

/**
 * One-click install links checked against the formats the clients document, decoded the way
 * the clients decode them. Not verified by clicking in a real Cursor / VS Code (no GUI client
 * in CI); these tests pin the documented wire format instead.
 *
 * Cursor — https://cursor.com/docs/context/mcp/install-links
 *   cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64_ENCODED_CONFIG
 *   config = base64(JSON.stringify(<one mcp.json server entry>)); remote entries use `url`
 *   (https://cursor.com/docs/context/mcp, "Remote Server" example uses { "url": ... }).
 * VS Code — https://code.visualstudio.com/api/extension-guides/ai/mcp ("Create an MCP installation URL")
 *   vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, ...serverConfig }))}
 *   server config per https://code.visualstudio.com/docs/copilot/reference/mcp-configuration:
 *   `type` is "stdio" | "http" | "sse"; http/sse need `url`.
 */
const urls = [
  'https://mcp.example.org/mcp/1b0218dc-c890-4427-98ac-5dd89e7953f6',
  'http://localhost:4300/mcp/585d166d-adbc-491d-af6e-97fdd9b0ce28',
  // Picked so the base64 contains "+": left unescaped, URLSearchParams would read it as a space.
  'https://h.example/mcp/~~~?a=>>>',
];

function cursorLink(href: string) {
  const link = new URL(href);
  expect(link.protocol).toBe('cursor:');
  expect(link.host).toBe('anysphere.cursor-deeplink');
  expect(link.pathname).toBe('/mcp/install');
  expect([...link.searchParams.keys()].sort()).toEqual(['config', 'name']);
  const raw = link.searchParams.get('config')!;
  expect(raw).toMatch(/^[A-Za-z0-9+/]+={0,2}$/); // standard base64 after URL decoding
  return {
    name: link.searchParams.get('name'),
    config: JSON.parse(Buffer.from(raw, 'base64').toString('utf8')),
  };
}

test('Cursor link: documented scheme/host/path, base64 mcp.json entry with only `url`', () => {
  for (const url of urls) {
    for (const name of ['team-kb', '团队 知识库 & co']) {
      const [entry, ...rest] = installLinks({ preset: 'cursor', name, url });
      expect(rest).toEqual([]);
      const decoded = cursorLink(entry!.href);
      if (url === urls[2]) expect(entry!.href).toContain('%2B');
      expect(decoded.name).toBe(name);
      expect(decoded.config).toEqual({ url });
      // A remote entry: no command/args, and nothing secret in the link.
      expect(decoded.config).not.toHaveProperty('command');
      expect(decoded.config).not.toHaveProperty('headers');
    }
  }
});

test('VS Code / Insiders link: encodeURIComponent(JSON) with name + type http + url', () => {
  for (const url of urls) {
    const links = installLinks({ preset: 'vscode', name: 'team-kb', url });
    expect(links.map((link) => link.href.split('?')[0])).toEqual([
      'vscode:mcp/install',
      'vscode-insiders:mcp/install',
    ]);
    for (const link of links) {
      const payload = link.href.slice(link.href.indexOf('?') + 1);
      const config = JSON.parse(decodeURIComponent(payload));
      // Exactly what the documented generator produces for this object.
      expect(payload).toBe(encodeURIComponent(JSON.stringify(config)));
      expect(config).toEqual({ name: 'team-kb', type: 'http', url });
      expect(['stdio', 'http', 'sse']).toContain(config.type);
      expect(config).not.toHaveProperty('headers');
    }
  }
});

test('install links are only offered for browser authorization, never with a key', () => {
  const url = urls[0]!;
  for (const preset of ['cursor', 'vscode'] as const) {
    const oauth = exportClient({ preset, url, auth: 'oauth', name: 'team-kb' });
    expect(oauth.links.length).toBeGreaterThan(0);
    for (const link of oauth.links) expect(link.href).not.toMatch(/Bearer|Authorization|token/i);
    expect(
      exportClient({ preset, url, token: 'secret-token-value', name: 'team-kb' }).links,
    ).toEqual([]);
    expect(exportClient({ preset, url, auth: 'key', name: 'team-kb' }).links).toEqual([]);
  }
  for (const preset of ['claude-code', 'claude-desktop', 'codex'] as const)
    expect(exportClient({ preset, url, auth: 'oauth', name: 'team-kb' }).links).toEqual([]);
});
