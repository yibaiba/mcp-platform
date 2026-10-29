$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '../connector/ssh/windows'
foreach ($file in Get-ChildItem -LiteralPath $source -Filter '*.ps1') {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count) { throw ($errors | Out-String) }
}
$directory = Join-Path ([IO.Path]::GetTempPath()) ('platform-ssh-test-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $directory | Out-Null
$previousPath = $env:PATH
try {
    # Native argv fixture only: no SSH network or Windows login success is simulated.
    $program = @'
using System;
class ArgvFixture {
    static int Main(string[] args) {
        foreach (var arg in args) Console.WriteLine(Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(arg)));
        return 23;
    }
}
'@
    Add-Type -TypeDefinition $program -OutputAssembly (Join-Path $directory 'ssh.exe') -OutputType ConsoleApplication
    $env:PATH = "$directory;$env:PATH"
    $identity = Join-Path $directory 'key with spaces'
    Set-Content -LiteralPath $identity -Value 'argv test placeholder, not a private key'
    $config = @{ id = [Guid]::NewGuid().ToString(); ssh = @{ host = 'ssh.example.test'; port = 2222; username = 'mcp'; identityFile = $identity; reconnectIntervalSeconds = 5 }; bindings = @(@{ localPort = 3000; remotePort = 13000 }, @{ localPort = 4000; remotePort = 14000 }) }
    $path = Join-Path $directory 'connection.json'
    $config | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $path -Encoding UTF8
    $output = & powershell.exe -NoProfile -File (Join-Path $source 'Connect-McpPlatform.ps1') -ConfigPath $path -Interactive
    if ($LASTEXITCODE -ne 23) { throw 'Native SSH exit code was lost' }
    $argv = @($output | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) })
    $expected = @('-N', '-T', '-p', '2222', '-l', 'mcp', '-i', $identity, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=no', '-o', 'StrictHostKeyChecking=ask', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-R', '127.0.0.1:13000:127.0.0.1:3000', '-R', '127.0.0.1:14000:127.0.0.1:4000', 'ssh.example.test')
    if (($argv -join "`n") -cne ($expected -join "`n")) { throw 'SSH argv boundaries or forwarding settings changed' }
    Write-Host 'PASS: Windows PowerShell parsing, literal argv (including spaced key path), multiple loopback forwards and native exit propagation. Startup/login and SSH network require separate actual-device checks.'
} finally {
    $env:PATH = $previousPath
    Remove-Item -LiteralPath $directory -Recurse -Force
}
