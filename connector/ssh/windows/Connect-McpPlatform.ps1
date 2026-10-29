param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'connection.json'),
    [switch]$Interactive
)

$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$ssh = Get-Command ssh.exe -ErrorAction Stop
$settings = $config.ssh
if (-not $settings -or -not $config.bindings.Count) {
    throw 'Configure an SSH connection with at least one MCP forwarding entry.'
}
$parsedAddress = $null
$isIp = [System.Net.IPAddress]::TryParse($settings.host, [ref]$parsedAddress)
if ((-not $isIp -and $settings.host -notmatch '^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$') -or
    $settings.username -notmatch '^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$') {
    throw 'Invalid SSH hostname or username in connection.json.'
}
if ($settings.port -lt 1 -or $settings.port -gt 65535 -or
    $settings.reconnectIntervalSeconds -lt 1) {
    throw 'Invalid SSH port or reconnect interval in connection.json.'
}

$identityFile = [Environment]::ExpandEnvironmentVariables($settings.identityFile)
if ($identityFile -match '^~[/\\]') {
    $identityFile = Join-Path $env:USERPROFILE $identityFile.Substring(2)
}
if (-not (Test-Path -LiteralPath $identityFile -PathType Leaf)) {
    throw 'SSH private key does not exist. Set ssh.identityFile in connection.json.'
}

$batchMode = if ($Interactive) { 'no' } else { 'yes' }
$hostChecking = if ($Interactive) { 'ask' } else { 'yes' }
$sshArgs = @(
    '-N', '-T', '-p', [string]$settings.port, '-l', $settings.username,
    '-i', $identityFile,
    '-o', 'IdentitiesOnly=yes',
    '-o', "BatchMode=$batchMode",
    '-o', "StrictHostKeyChecking=$hostChecking",
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3'
)
foreach ($binding in $config.bindings) {
    if ($binding.localPort -lt 1 -or $binding.localPort -gt 65535 -or
        $binding.remotePort -lt 1 -or $binding.remotePort -gt 65535) {
        throw 'Each forwarding entry needs valid localPort and remotePort values.'
    }
    $sshArgs += @('-R', "127.0.0.1:$($binding.remotePort):127.0.0.1:$($binding.localPort)")
}
$sshArgs += $settings.host

# Interactive setup lets the operator verify the host fingerprint and unlock the key.
if ($Interactive) {
    & $ssh.Source @sshArgs
    exit $LASTEXITCODE
}

$logPath = Join-Path $PSScriptRoot 'connection.log'
while ($true) {
    Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$(Get-Date -Format o) Connecting to $($settings.host)"
    # Preserve native SSH diagnostics on Windows PowerShell 5.1 as well as PowerShell 7.
    $ErrorActionPreference = 'Continue'
    & $ssh.Source @sshArgs 2>&1 | ForEach-Object {
        Add-Content -LiteralPath $logPath -Encoding UTF8 -Value ($_.ToString()) -ErrorAction Stop
        Write-Output $_
    }
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    Add-Content -LiteralPath $logPath -Encoding UTF8 -Value "$(Get-Date -Format o) SSH exited with code $exitCode; reconnecting in $($settings.reconnectIntervalSeconds)s"
    Start-Sleep -Seconds $settings.reconnectIntervalSeconds
}
