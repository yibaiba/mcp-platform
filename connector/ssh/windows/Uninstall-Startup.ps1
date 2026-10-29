$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'connection.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.id -notmatch '^[a-zA-Z0-9-]+$') { throw 'Invalid device ID.' }
$taskName = "MCPPlatform-SSH-$($config.id)"
Stop-ScheduledTask -TaskName $taskName
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Removed $taskName. Local MCP applications and SSH keys were not modified."
