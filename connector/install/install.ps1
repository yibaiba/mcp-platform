param(
    [Parameter(Mandatory = $true)][string]$Server,
    [switch]$InstallOnly
)
$ErrorActionPreference = 'Stop'
$Server = $Server.TrimEnd('/')
$origin = [Uri]$Server
if (-not $origin.IsAbsoluteUri -or $origin.UserInfo -or $origin.Query -or $origin.Fragment -or $origin.AbsolutePath -ne '/') {
    throw 'Server must be an origin URL.'
}
if ($origin.Scheme -ne 'https' -and -not ($origin.Scheme -eq 'http' -and $origin.IsLoopback)) {
    throw 'Remote platforms require HTTPS; HTTP is allowed only for loopback development.'
}
if ($env:OS -ne 'Windows_NT') { throw 'This installer requires Windows. macOS and Linux use install.sh.' }
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
switch ($architecture) {
    'X64' { $targetArch = 'amd64' }
    'Arm64' { $targetArch = 'arm64' }
    default { throw "Unsupported architecture: $architecture. The connector requires x64 or ARM64." }
}
$filename = "connector-windows-$targetArch.exe"
$installDir = $env:MCP_PLATFORM_CONNECTOR_HOME
if (-not $installDir) {
    $installDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MCPPlatform\Connector'
}
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
$temporary = Join-Path $installDir ('.install.' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
$destination = Join-Path $installDir 'connector.exe'
try {
    Invoke-WebRequest -UseBasicParsing -Uri "$Server/api/v1/connector/downloads/SHA256SUMS" -OutFile (Join-Path $temporary 'SHA256SUMS')
    Invoke-WebRequest -UseBasicParsing -Uri "$Server/api/v1/connector/downloads/$filename" -OutFile (Join-Path $temporary $filename)
    $pattern = '^[0-9a-fA-F]{64}  ' + [Regex]::Escape($filename) + '$'
    $entries = @(Get-Content (Join-Path $temporary 'SHA256SUMS') | Where-Object { $_ -match $pattern })
    if ($entries.Count -ne 1) { throw 'Missing or duplicate SHA256SUMS entry.' }
    $expected = $entries[0].Substring(0, 64)
    $actual = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $temporary $filename)).Hash
    if ($actual -ne $expected) { throw 'Connector checksum mismatch; nothing was installed.' }
    Move-Item -Path (Join-Path $temporary $filename) -Destination $destination -Force
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
Write-Host "Connector installed: $destination"
if ($InstallOnly) { return }
Write-Host "Connecting to $Server. Paste the pairing code when prompted."
& $destination connect --server $Server --config (Join-Path $installDir 'connector.json')
if ($LASTEXITCODE -ne 0) { throw "Connector exited with status $LASTEXITCODE." }
