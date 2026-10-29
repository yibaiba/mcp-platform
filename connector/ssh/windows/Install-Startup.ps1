$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'connection.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.id -notmatch '^[a-zA-Z0-9-]+$') { throw 'Invalid device ID.' }
$scriptPath = Join-Path $PSScriptRoot 'Connect-McpPlatform.ps1'
if ($scriptPath -match '["\r\n]') { throw 'The installation path contains unsupported characters.' }
$taskName = "MCPPlatform-SSH-$($config.id)"
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Argument "-NoProfile -NonInteractive -File `"$scriptPath`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "Registered and started $taskName. Inspect connection.log for SSH errors and verify MCP status in the dashboard."
