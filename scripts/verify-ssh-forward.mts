import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createServer, connect } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { harness } from '../tests/harness.js';
import { fixtureMcp } from '../tests/fixtureMcp.js';
const directory = await mkdtemp(join(homedir(), '.platform-ssh-test-'));
const h = await harness();
const mcp = await fixtureMcp();
let daemon: ChildProcess | undefined;
let tunnel: ChildProcess | undefined;
let diagnostics = '';
async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function ready(port: number, process: ChildProcess) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`SSH exited: ${diagnostics}`);
    const connected = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.setTimeout(100);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await pause(50);
  }
  throw new Error(`SSH listener timed out: ${diagnostics}`);
}
function start(command: string, args: string[]) {
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr!.on('data', (chunk) => {
    diagnostics += chunk;
  });
  child.on('error', (error) => {
    diagnostics += String(error);
  });
  return child;
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  try {
    await done;
  } finally {
    clearTimeout(timer);
  }
}
try {
  const sshPort = await port();
  const remotePort = await port();
  const localPort = Number(new URL(mcp.url).port);
  const hostKey = join(directory, 'host');
  const identity = join(directory, 'identity');
  for (const path of [hostKey, identity])
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path], { timeout: 10000 });
  const knownHosts = join(directory, 'known_hosts');
  await writeFile(knownHosts, `[127.0.0.1]:${sshPort} ${await readFile(`${hostKey}.pub`, 'utf8')}`);
  const config = join(directory, 'sshd_config');
  await writeFile(
    config,
    [
      `Port ${sshPort}`,
      'ListenAddress 127.0.0.1',
      `HostKey "${hostKey}"`,
      `PidFile "${join(directory, 'pid')}"`,
      `AuthorizedKeysFile "${identity}.pub"`,
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'UsePAM no',
      'AllowTcpForwarding remote',
      'GatewayPorts no',
      `PermitListen 127.0.0.1:${remotePort}`,
      `AllowUsers ${userInfo().username}`,
      'LogLevel VERBOSE',
    ].join('\n') + '\n',
  );
  daemon = start(process.env.SSHD_BIN ?? '/usr/sbin/sshd', ['-D', '-e', '-f', config]);
  await ready(sshPort, daemon);
  const args = [
    '-F',
    '/dev/null',
    '-N',
    '-T',
    '-p',
    String(sshPort),
    '-l',
    userInfo().username,
    '-i',
    identity,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    'ExitOnForwardFailure=yes',
    '-R',
    `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`,
    '127.0.0.1',
  ];
  tunnel = start('ssh', args);
  await ready(remotePort, tunnel);
  const account = await h.signup();
  const connection = await h.services.connections.create(account.ownerId, {
    name: 'real SSH fixture',
    adapter: 'direct',
    transport: 'http',
    mode: 'existing',
    url: `http://127.0.0.1:${remotePort}/mcp`,
    connectTimeoutMs: 1000,
    requestOptions: { timeoutMs: 1000 },
  });
  const response = await account.request('/ssh-accesses', {
    method: 'POST',
    body: JSON.stringify({
      name: 'SSH fixture',
      platform: process.platform === 'darwin' ? 'macos' : 'linux',
      ssh: {
        host: '127.0.0.1',
        port: sshPort,
        username: userInfo().username,
        identityFile: identity,
      },
      bindings: [{ connectionId: connection.id, localPort, remotePort }],
    }),
  });
  assert.equal(response.status, 201, await response.text());
  const tools = await h.services.connections.discover(account.ownerId, connection.id);
  const result = await h.services.invocations.call({
    ownerId: account.ownerId,
    toolId: tools[0]!.id,
    arguments: { message: 'through real OpenSSH' },
  });
  assert(JSON.stringify(result).includes('through real OpenSSH'));
  assert.equal(mcp.count(), 1);
  await stop(tunnel);
  await assert.rejects(
    h.services.invocations.call({ ownerId: account.ownerId, toolId: tools[0]!.id, arguments: {} }),
  );
  assert.equal(mcp.count(), 1, 'A disconnected call must never replay');
  tunnel = start('ssh', args);
  await ready(remotePort, tunnel);
  await h.services.connections.discover(account.ownerId, connection.id);
  assert.equal(mcp.count(), 1, 'Reconnection must only rediscover');
  console.log(
    'PASS: real OpenSSH reverse forwarding, actual MCP discovery/call, disconnect failure and explicit reconnect without tool replay',
  );
} finally {
  await h.close();
  await mcp.close();
  await stop(tunnel);
  await stop(daemon);
  await rm(directory, { recursive: true, force: true });
}
