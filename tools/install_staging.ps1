param(
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [Parameter(Mandatory=$true)][string]$Archive,
    [Parameter(Mandatory=$true)][string]$Sha256,
    [string]$ServiceName = 'RisuHina',
    [int]$Port = 6020
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = (Resolve-Path -LiteralPath $InstallRoot).Path.TrimEnd('\')
function In-Root([string]$relative) {
    $resolved = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $resolved.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Path outside install: $relative" }
    return $resolved
}
if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $Sha256) { throw 'Archive checksum mismatch' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stage = In-Root "_stage\apply-$stamp"
$backup = In-Root "_stage\backup-$stamp"
New-Item -ItemType Directory -Path $stage, $backup | Out-Null
Expand-Archive -LiteralPath $Archive -DestinationPath $stage
$manifest = Get-Content -LiteralPath "$stage\staging-manifest.json" -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($entry in $manifest.files) {
    if ($entry.path -notmatch '^(pyserver/app/|plugin/risu-hina-[0-9.]+\.js$)') { throw 'Unexpected payload path' }
    $source = [IO.Path]::GetFullPath((Join-Path $stage $entry.path))
    if (-not $source.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Payload traversal' }
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Payload checksum mismatch: $($entry.path)" }
    $null = In-Root $entry.path
}
$service = Get-Service -Name $ServiceName
Stop-Service -Name $ServiceName
$service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
$applied = $false
try {
    # Backups remain on this host. Images in studio/output are never rewritten.
    Copy-Item -LiteralPath (In-Root 'pyserver\app') -Destination "$backup\app" -Recurse
    foreach ($relative in @('data\skills', 'data\skill-history', 'data\agent-notes', 'data\space\studio\config', 'data\plugin')) {
        $source = In-Root $relative
        if (Test-Path -LiteralPath $source) {
            $dest = Join-Path $backup $relative
            New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination $dest -Recurse
        }
    }
    foreach ($name in @('risuhina.db', 'risuhina.db-wal', 'risuhina.db-shm')) {
        $source = In-Root "data\$name"
        if (Test-Path -LiteralPath $source) {
            New-Item -ItemType Directory -Path "$backup\data" -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination "$backup\data\$name"
        }
    }
    $applied = $true
    foreach ($entry in $manifest.files) {
        $relative = $entry.path
        if ($relative.StartsWith('plugin/')) { $relative = 'data/' + $relative }
        $dest = In-Root $relative
        New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $stage $entry.path) -Destination $dest -Force
        (Get-Item -LiteralPath $dest).LastWriteTime = Get-Date
    }
    Start-Service -Name $ServiceName
    $healthy = $false
    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
            if ($health.ok -and $health.version -eq $manifest.version) { $healthy = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 1000
    }
    if (-not $healthy) { throw 'New staging version did not become healthy' }
    $pluginEntry = $manifest.files | Where-Object { $_.path.StartsWith('plugin/') } | Select-Object -First 1
    $download = Join-Path $stage 'served-plugin.js'
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port/plugin.js" -UseBasicParsing -OutFile $download
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $pluginEntry.sha256) { throw 'Served plugin checksum mismatch' }
    Write-Output (ConvertTo-Json @{ version=$manifest.version; healthy=$true; backup=$backup; pluginVerified=$true } -Compress)
} catch {
    $problem = $_
    Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
    (Get-Service -Name $ServiceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    if ($applied) {
        Copy-Item -Path "$backup\app\*" -Destination (In-Root 'pyserver\app') -Recurse -Force
        foreach ($entry in $manifest.files | Where-Object { $_.path.StartsWith('plugin/') }) {
            # This exact newly deployed file is confined before deletion.
            $deployedPlugin = In-Root ('data/' + $entry.path)
            Remove-Item -LiteralPath $deployedPlugin -Force
        }
        if (Test-Path -LiteralPath "$backup\data\plugin") {
            Copy-Item -Path "$backup\data\plugin\*" -Destination (In-Root 'data\plugin') -Force
        }
    }
    Start-Service -Name $ServiceName
    throw "Staging update failed; previous application restored. Backup: $backup. $problem"
}
