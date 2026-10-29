import { spawn, execFileSync } from 'node:child_process';
execFileSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['--filter', 'web', 'build:local'],
  {
    stdio: 'inherit',
    timeout: 60_000,
  },
);
// Build the actual connector before starting the hard-timed backend test process.
execFileSync('go', ['build', '-o', 'bin/connector', './cmd/connector'], {
  cwd: new URL('../connector/', import.meta.url),
  stdio: 'inherit',
  timeout: 60_000,
});
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
function runGroup(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['exec', 'vitest', 'run', ...args], {
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    const timeout = setTimeout(() => {
      console.error('Backend test group exceeded the hard 60-second timeout');
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    }, 60_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
  });
}

// Core, Pi and protocol integration each retain their own hard timeout.
const requested = process.argv.slice(2);
const groups = requested.length
  ? [requested]
  : [
      [
        '--exclude',
        'tests/workspace*.test.ts',
        '--exclude',
        'tests/pi.test.ts',
        '--exclude',
        'tests/catalog*.test.ts',
        '--exclude',
        'tests/apps.test.ts',
        '--exclude',
        'tests/*Interactions.test.ts',
        '--exclude',
        'tests/interactions.test.ts',
        '--exclude',
        'tests/openapi*.test.ts',
        '--exclude',
        'tests/sessionIsolation.test.ts',
        '--exclude',
        'tests/lifecycle.test.ts',
        '--exclude',
        'tests/upstreamOAuth.test.ts',
        '--exclude',
        'tests/connectionBudget.test.ts',
        '--exclude',
        'tests/users.test.ts',
        '--exclude',
        'tests/loginProviders.test.ts',
        '--exclude',
        'tests/activity*.test.ts',
        '--exclude',
        'tests/shares*.test.ts',
        '--exclude',
        'tests/core.test.ts',
        '--exclude',
        'tests/openapiOAuth.test.ts',
        '--exclude',
        'tests/mcpReliability.test.ts',
        '--exclude',
        'tests/manifests*.test.ts',
        '--exclude',
        'tests/projection.test.ts',
        '--exclude',
        'tests/market.test.ts',
        '--exclude',
        'tests/discovery.test.ts',
        '--exclude',
        'tests/rest.test.ts',
        '--exclude',
        'tests/vectorSearch.test.ts',
        '--exclude',
        'tests/runtimeMetrics.test.ts',
        '--exclude',
        'tests/cliAuth.test.ts',
        '--exclude',
        'tests/resultPresentation.test.ts',
        '--exclude',
        'tests/localManagement.test.ts',
        '--exclude',
        'tests/sshAccess.test.ts',
        '--exclude',
        'tests/packageUpdates.test.ts',
        '--exclude',
        'tests/platformUpdates.test.ts',
        '--exclude',
        'tests/network*.test.ts',
        '--exclude',
        'tests/connector*.test.ts',
        '--exclude',
        'tests/devices.test.ts',
        '--exclude',
        'tests/deviceAuth.test.ts',
        '--exclude',
        'tests/library.test.ts',
        '--exclude',
        'tests/bundles*.test.ts',
      ],
      [
        'tests/network.test.ts',
        'tests/networkGit.test.ts',
        'tests/networkAuth.test.ts',
        'tests/networkRunners.test.ts',
      ],
      [
        'tests/connectorDistribution.test.ts',
        'tests/connectorInstaller.test.ts',
        'tests/connectorPresets.test.ts',
      ],
      ['tests/devices.test.ts', 'tests/deviceAuth.test.ts'],
      ['tests/library.test.ts', 'tests/bundles.test.ts', 'tests/bundlesDevice.test.ts'],
      [
        'tests/workspacePermissions.test.ts',
        'tests/workspaceIdentity.test.ts',
        'tests/workspaceHandoffs.test.ts',
        'tests/workspaceExternalTools.test.ts',
      ],
      [
        'tests/vectorSearch.test.ts',
        'tests/runtimeMetrics.test.ts',
        'tests/resultPresentation.test.ts',
      ],
      ['tests/cliAuth.test.ts'],
      ['tests/packageUpdates.test.ts', 'tests/platformUpdates.test.ts'],
      ['tests/localManagement.test.ts'],
      ['tests/sshAccess.test.ts'],
      ['tests/workspaceOutputArtifacts.test.ts'],
      ['tests/pi.test.ts'],
      ['tests/core.test.ts', 'tests/openapiOAuth.test.ts', 'tests/mcpReliability.test.ts'],
      [
        'tests/users.test.ts',
        'tests/loginProviders.test.ts',
        'tests/activity.test.ts',
        'tests/activityLegacy.test.ts',
      ],
      ['tests/shares.test.ts'],
      ['tests/market.test.ts', 'tests/discovery.test.ts', 'tests/rest.test.ts'],
      ['tests/sharesSurfaces.test.ts'],
      ['tests/sharesOAuth.test.ts'],
      ['tests/connectionBudget.test.ts'],
      ['tests/upstreamOAuth.test.ts'],
      [
        'tests/manifests.test.ts',
        'tests/manifestsLifecycle.test.ts',
        'tests/manifestsRegression.test.ts',
      ],
      ['tests/catalogProjection.test.ts', 'tests/projection.test.ts'],
      ['tests/catalog.test.ts', 'tests/catalogAdapters.test.ts'],
      ['tests/apps.test.ts', 'tests/interactions.test.ts', 'tests/legacyInteractions.test.ts'],
      [
        'tests/openapi.test.ts',
        'tests/openapiSchemas.test.ts',
        'tests/sessionIsolation.test.ts',
        'tests/lifecycle.test.ts',
      ],
    ];
for (const [index, args] of groups.entries()) {
  console.log(`Backend test group ${index + 1}/${groups.length}: ${args.join(' ')}`);
  const code = await runGroup(args);
  if (code !== 0) process.exitCode = 1;
}
