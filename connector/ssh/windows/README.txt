MCPPlatform-SSH Windows connection package

1. Extract this entire archive into a permanent folder. Keep all files together.
2. Check ssh -V. Install the Windows OpenSSH Client optional feature if missing.
3. Configure the SSH public key on the cloud host. Set ssh.identityFile in
   connection.json to this computer's private-key path. No private key or cloud
   dashboard credential is included in this package.
4. Start the local MCP HTTP services. Preserve their existing startup settings.
   This package forwards connections; it does not start MCP servers or applications.
5. In PowerShell, run .\Connect-McpPlatform.ps1 -Interactive. Verify the SSH host
   fingerprint against the cloud host's trusted fingerprint before accepting it.
   Keep the command running and verify the MCP servers in the dashboard, then
   press Ctrl+C. Passphrase-protected keys must be available through ssh-agent
   for unattended use. BatchMode=yes never prompts for passwords in the task.
6. Run .\Install-Startup.ps1 to start the tunnel now and at this user's next login.
   The folder must stay at its current path. Inspect connection.log for errors.
7. Run .\Uninstall-Startup.ps1 to stop and remove the startup task.

If downloaded scripts are blocked, review the scripts first, then use Unblock-File
on the reviewed .ps1 files. Follow your organization's script execution policy;
this package does not change that policy or bypass it.

One SSH connection forwards every configured MCP. Remote listeners bind only to
127.0.0.1. The cloud SSH service must allow remote forwarding and use GatewayPorts
no. Public firewall rules for the forwarding ports are unnecessary.

Automatic reconnect repeats failed SSH connection attempts at the configured
interval and records the errors. It never replays MCP tool calls. To stop these
attempts, stop the MCPPlatform-SSH task in Task Scheduler or uninstall the startup task.

The computer must be awake, connected, and logged in. A tunnel connected at the
network level does not prove that a local MCP service is healthy. Use the actual
MCP server status in the dashboard. Enable background recovery in the MCP connection settings if you want the
platform to rediscover it when the tunnel becomes available again.

Deleting an SSH access in MCP Platform removes only its inventory entry. It does not remove
this computer's startup task, delete its MCP servers, or revoke its SSH key.

The SSH listener and platform must share a network namespace. A platform in a
Docker bridge cannot access the host loopback listener.
