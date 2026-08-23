# Risu Elf backend control for test-server.
#
# ASCII only: PowerShell 5.1 reads a BOM-less UTF-8 .ps1 as the system ANSI
# codepage, so Korean in a script turns to mojibake. Nothing here needs it.
#
# It is a file rather than an inline command because ssh -> cmd -> powershell
# quoting mangles pipes and nested quotes; running a file takes all of that off
# the command line.
#
#   powershell -ExecutionPolicy Bypass -NoProfile -File risuelf_ctl.ps1 -Action setup
#   powershell -ExecutionPolicy Bypass -NoProfile -File risuelf_ctl.ps1 -Action start
#   powershell -ExecutionPolicy Bypass -NoProfile -File risuelf_ctl.ps1 -Action status
#   powershell -ExecutionPolicy Bypass -NoProfile -File risuelf_ctl.ps1 -Action stop

param(
    [ValidateSet('setup', 'start', 'stop', 'restart', 'status', 'token')]
    [string]$Action = 'status',
    [int]$Port = 6020,
    # Where to keep the database, config, token and workspaces. Defaults to
    # <install>\data, next to pyserver\ rather than inside it, so a version
    # swap never has to step around the user's chats.
    [string]$DataDir = '',
    # Which interpreter builds the venv. Left empty, the script looks for one.
    [string]$Python = ''
)

$ErrorActionPreference = 'Stop'

# Strip quotes that survived the trip.
#
# Deployment happens over ssh -> cmd.exe -> powershell, and each hop removes
# one layer of quoting - so -DataDir 'D:\path' can arrive with the quotes still
# part of the value. The failure that produces is DriveNotFoundException on a
# drive called "'D", which says nothing about what actually went wrong.
function Unquote([string]$v) {
    if (-not $v) { return $v }
    return $v.Trim().Trim("'").Trim('"')
}
$DataDir = Unquote $DataDir
$Python = Unquote $Python

# Everything is derived from where this file sits, so the install can be
# anywhere. It used to hardcode D:\risu-elf, which meant a second install -
# or anyone else's - silently controlled the first one's paths.
#
# Two placements are supported. A release unpacks this at the install root next
# to pyserver\; older installs have it inside pyserver\. The root placement is
# the better one - it keeps the operator's entry points out of the directory an
# update replaces - but breaking existing installs to get there is not worth it.
if (Test-Path (Join-Path $PSScriptRoot 'app')) {
    $Server = $PSScriptRoot
    $Root = Split-Path $Server -Parent
} elseif (Test-Path (Join-Path $PSScriptRoot 'pyserver\app')) {
    $Root = $PSScriptRoot
    $Server = Join-Path $Root 'pyserver'
} else {
    throw "cannot find app - looked in $PSScriptRoot and $PSScriptRoot\pyserver"
}
$Venv = Join-Path $Server '.venv'
$VenvPy = Join-Path $Venv 'Scripts\python.exe'
$Entry = Join-Path $Server 'run.py'
$Log = Join-Path $Server 'server.log'
if (-not $DataDir) { $DataDir = Join-Path $Root 'data' }

function Find-Python {
    if ($Python) {
        if (-not (Test-Path $Python)) { throw "no interpreter at $Python" }
        return $Python
    }
    # 3.11 first because that is what the deployment is pinned to, then
    # whatever python is on PATH. Reported either way, so a wrong pick is
    # visible rather than a puzzling import error later.
    $candidates = @()
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        $found = & py -3.11 -c "import sys; print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $found) { $candidates += $found.Trim() }
    }
    foreach ($p in @(
        'C:\Program Files\Python311\python.exe',
        'C:\Program Files\Python312\python.exe',
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe")) {
        if (Test-Path $p) { $candidates += $p }
    }
    $onPath = Get-Command python -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }

    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    throw 'no Python found. Install 3.11 or pass -Python <path to python.exe>'
}

function Get-ServerProcesses {
    # Matched on this install's own run.py, not on a name in the path. The old
    # rule looked for '*risu-elf*run.py*', so an install in a directory not
    # called risu-elf reported nothing running while the server was up - and
    # stop silently did nothing.
    $needle = $Entry.ToLower()
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($needle) }
}

function Invoke-Setup {
    $SysPy = Find-Python
    Write-Output ("setup: using {0}" -f $SysPy)
    & $SysPy -c "import sys; assert sys.version_info[:2] >= (3, 10), sys.version"
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 or newer is required' }
    if (-not (Test-Path $VenvPy)) {
        Write-Output 'setup: creating venv'
        & $SysPy -m venv $Venv
    }
    Write-Output 'setup: installing dependencies'
    & $VenvPy -m pip install --quiet --upgrade pip
    & $VenvPy -m pip install --quiet -r (Join-Path $Server 'requirements.in')
    & $VenvPy -c "import fastapi, uvicorn, httpx; print('setup: fastapi', fastapi.__version__, 'uvicorn', uvicorn.__version__)"
    try { New-Item -ItemType Directory -Force $DataDir | Out-Null }
    catch { throw ("cannot create data dir {0}: {1}" -f $DataDir, $_.Exception.Message) }
    # Pinned to a file rather than passed at launch: Win32_Process.Create runs
    # under the WMI service and inherits none of this session's environment, so
    # an env var would simply not arrive. The file also makes every supervisor
    # agree about where the data is.
    $pin = Join-Path $Server 'datadir.txt'
    if ($DataDir -eq (Join-Path $Root 'data')) {
        Remove-Item $pin -ErrorAction SilentlyContinue
    } else {
        # Not Set-Content -Encoding utf8: PowerShell 5.1 writes a BOM with
        # that, and the BOM becomes part of the path Python reads - producing
        # a directory literally named "\ufeffD:\..." resolved against
        # whatever the service's working directory happened to be.
        [System.IO.File]::WriteAllText($pin, $DataDir)
        Write-Output ("setup: pinned data dir in {0}" -f $pin)
    }
    Write-Output ("setup: data dir {0}" -f $DataDir)
}

function Stop-Server {
    $procs = @(Get-ServerProcesses)
    if ($procs.Count -eq 0) { Write-Output 'stop: nothing running'; return }
    foreach ($p in $procs) {
        # Killing the venv launcher takes its child with it, so by the time the
        # loop reaches the child it is already gone. That is success, not the
        # failure the old message reported.
        if (-not (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue)) {
            Write-Output ("stop: pid {0} already gone" -f $p.ProcessId)
            continue
        }
        try { Stop-Process -Id $p.ProcessId -Force; Write-Output ("stop: killed pid {0}" -f $p.ProcessId) }
        catch {
            # Re-check rather than trust the pre-check: killing the launcher
            # takes the child down, and the child can disappear between the
            # look and the kill. Gone is what we wanted either way.
            if (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue) {
                Write-Output ("stop: could not kill {0}: {1}" -f $p.ProcessId, $_.Exception.Message)
            } else {
                Write-Output ("stop: pid {0} exited with its parent" -f $p.ProcessId)
            }
        }
    }
}

function Start-Server {
    if (-not (Test-Path $VenvPy)) { throw "venv missing - run -Action setup first" }
    # Win32_Process.Create runs under the WMI service, outside the SSH session's
    # job object. Start-Process does not: OpenSSH kills the whole job when the
    # session ends, which looks like a successful start that leaves nothing
    # listening. The .bat owns all quoting so this command line needs none.
    # The launcher lives at the install root in a release tree and inside
    # pyserver\ in older installs. Both are checked rather than assumed.
    $bat = Join-Path $Root 'start.bat'
    if (-not (Test-Path $bat)) { $bat = Join-Path $Server 'start.bat' }
    if (-not (Test-Path $bat)) {
        throw ("cannot find start.bat - looked in {0} and {1}" -f $Root, $Server)
    }
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = 'cmd.exe /c ' + $bat + ' ' + $Port
    }
    if ($r.ReturnValue -ne 0) { throw ("Win32_Process.Create returned {0}" -f $r.ReturnValue) }
    Write-Output ("start: pid {0}" -f $r.ProcessId)
    Start-Sleep -Seconds 4
}

function Get-DataDir {
    # The pin is what the server actually reads, so it is what status must
    # report. Echoing the -DataDir parameter instead told you what you had just
    # typed, which is never the question being asked.
    $pin = Join-Path $Server 'datadir.txt'
    if (Test-Path $pin) {
        $v = ([System.IO.File]::ReadAllText($pin)).Trim([char]0xFEFF).Trim()
        if ($v) { return $v }
    }
    return (Join-Path $Root 'data')
}

function Get-Status {
    Write-Output ("install    {0}" -f $Root)
    Write-Output ("data       {0}" -f (Get-DataDir))

    $procs = @(Get-ServerProcesses)
    # Two processes is normal on Windows and not a duplicate server. A venv's
    # Scripts\python.exe is venvlauncher.exe, which starts the real interpreter
    # as a child and stays alive as its parent - so both match this install's
    # run.py. Saying so here stops "processes: 2" from reading as a bug.
    $note = if ($procs.Count -eq 2) { ' (venv launcher + server, normal)' }
            elseif ($procs.Count -gt 2) { ' - more than expected' }
            else { '' }
    Write-Output ("processes  {0}{1}" -f $procs.Count, $note)
    foreach ($p in $procs) { Write-Output ("           pid {0}" -f $p.ProcessId) }

    # Must match LISTENING specifically: a bare ":6020" also matches TIME_WAIT
    # rows from a client socket and reports a live server when nothing is bound.
    $listening = @(netstat -ano -p tcp |
        Select-String -SimpleMatch 'LISTENING' |
        Select-String -SimpleMatch ("127.0.0.1:{0}" -f $Port))
    Write-Output ("listening  {0} on {1}" -f $(if ($listening.Count) { 'yes' } else { 'NO' }), $Port)

    try {
        $res = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri ("http://127.0.0.1:{0}/health" -f $Port)
        Write-Output ("health     {0}" -f $res.Content)
    } catch {
        Write-Output ("health     unreachable ({0})" -f $_.Exception.Message)
        if (Test-Path $Log) {
            Write-Output '--- log tail ---'
            Get-Content $Log -Tail 25 | ForEach-Object { Write-Output $_ }
        }
    }
}

function Show-Token {
    $t = Join-Path (Get-DataDir) 'token.txt'
    if (Test-Path $t) { Write-Output ("token: {0}" -f (Get-Content $t -Raw).Trim()) }
    else { Write-Output 'token: not issued yet (start the server once)' }
}

switch ($Action) {
    'setup'   { Invoke-Setup }
    'start'   { Start-Server; Get-Status }
    'stop'    { Stop-Server }
    'restart' { Stop-Server; Start-Sleep -Seconds 1; Start-Server; Get-Status }
    'status'  { Get-Status }
    'token'   { Show-Token }
}
