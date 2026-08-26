# Everything setup.bat and uninstall.bat do.
#
# The logic lives here rather than in the .bat files because cmd is a poor place
# to find an interpreter, create a venv and talk to a service manager. The .bat
# files at the install root are two-line wrappers; this is the whole of it.
#
#   powershell -ExecutionPolicy Bypass -File pyserver\manage.ps1 -Action setup
#   powershell -ExecutionPolicy Bypass -File pyserver\manage.ps1 -Action status
#
# ASCII only: PowerShell 5.1 reads a BOM-less UTF-8 .ps1 as the system ANSI
# codepage, so Korean in a script turns to mojibake.
param(
    [ValidateSet('setup', 'uninstall', 'start', 'stop', 'restart', 'status', 'token')]
    [string]$Action = 'status',
    [int]$Port = 6020,
    # Where the database, config, token and workspaces live. Defaults to
    # <install>\data, beside pyserver\ rather than inside it, so a version swap
    # never has to step around the user's chats.
    [string]$DataDir = '',
    # Which interpreter builds the venv. Empty means "go and find one".
    [string]$Python = '',
    # Keep it running across reboots, via NSSM.
    [switch]$Service,
    [string]$Name = 'RisuHina',
    # setup: install only, do not start. uninstall: also delete venv and data.
    [switch]$NoStart,
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'

# Strip quotes that survived the trip.
#
# Deployment happens over ssh -> cmd.exe -> powershell, and each hop removes one
# layer of quoting, so -DataDir 'D:\path' can arrive with the quotes still part
# of the value. The failure that produces is DriveNotFoundException on a drive
# called "'D", which says nothing about what actually went wrong.
function Unquote([string]$v) {
    if (-not $v) { return $v }
    return $v.Trim().Trim("'").Trim('"')
}
$DataDir = Unquote $DataDir
$Python = Unquote $Python
$Name = Unquote $Name

# This file sits in pyserver\; the install root is its parent.
$Server = $PSScriptRoot
$Root = Split-Path $Server -Parent
if (-not (Test-Path (Join-Path $Server 'app'))) {
    throw "cannot find app\ next to this script ($Server)"
}
$Venv = Join-Path $Server '.venv'
# The interpreter the release ships, with its dependencies already installed.
# When it is there, nothing on this machine is consulted - that is the point of
# bundling it. The venv path below is for a source checkout, which has no
# python\ and builds one from whatever python it can find.
$BundledPy = Join-Path $Server 'python\python.exe'
$VenvPy = if (Test-Path $BundledPy) { $BundledPy } else { Join-Path $Venv 'Scripts\python.exe' }
$Entry = Join-Path $Server 'run.py'
$Log = Join-Path $Server 'server.log'
$Bat = Join-Path $Server 'start.bat'
$Pin = Join-Path $Server 'datadir.txt'

function Get-DataDir {
    # The pin is what the server actually reads, so it is what status must
    # report. Echoing the -DataDir parameter told you what you had just typed,
    # which is never the question being asked.
    if (Test-Path $Pin) {
        $v = ([System.IO.File]::ReadAllText($Pin)).Trim([char]0xFEFF).Trim()
        if ($v) { return $v }
    }
    return (Join-Path $Root 'data')
}

function Find-Python {
    if ($Python) {
        if (-not (Test-Path $Python)) { throw "no interpreter at $Python" }
        return $Python
    }
    # 3.11 first because that is what this is pinned to, then anything 3.10+.
    # Whichever is picked is reported, because a wrong pick surfaces much later
    # as an import error that says nothing about which python was used.
    $candidates = @()
    if (Get-Command py -ErrorAction SilentlyContinue) {
        foreach ($v in @('-3.11', '-3.12', '-3.10')) {
            $found = & py $v -c "import sys; print(sys.executable)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $found) { $candidates += $found.Trim() }
        }
    }
    foreach ($p in @(
        'C:\Program Files\Python311\python.exe',
        'C:\Program Files\Python312\python.exe',
        'C:\Program Files\Python310\python.exe',
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe")) {
        if (Test-Path $p) { $candidates += $p }
    }
    $onPath = Get-Command python -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }

    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) {
            & $c -c "import sys; raise SystemExit(0 if sys.version_info[:2] >= (3,10) else 1)" 2>$null
            if ($LASTEXITCODE -eq 0) { return $c }
        }
    }
    throw 'no Python 3.10 or newer found. Install it, or pass -Python <path to python.exe>'
}

function Get-ServerProcesses {
    # Matched on this install's own run.py, not on a name in the path: an
    # install in a directory not called risu-hina used to report nothing running
    # while the server was up, and stop silently did nothing.
    $needle = $Entry.ToLower()
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($needle) }
}

function Find-Nssm {
    $onPath = Get-Command nssm -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    foreach ($p in @(
        'C:\nssm\nssm.exe',
        'C:\Program Files\nssm\nssm.exe',
        'C:\ProgramData\chocolatey\bin\nssm.exe',
        "$env:LOCALAPPDATA\Microsoft\WinGet\Links\nssm.exe")) {
        if (Test-Path $p) { return $p }
    }
    return ''
}

function Test-Admin {
    return ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Setup {
    # Same reason start.bat clears it: a stray PYTHONHOME points the bundled
    # interpreter at someone else's stdlib and it dies before printing a
    # useful word. (The ._pth already neutralises PYTHONPATH.)
    $env:PYTHONHOME = $null
    if (Test-Path $BundledPy) {
        # Nothing to install: the interpreter and every dependency came in
        # the archive, hash-pinned. Just prove they load.
        $v = & $BundledPy -c "import sys; print('%d.%d.%d' % sys.version_info[:3])"
        Write-Output ("setup: bundled Python {0}" -f $v)
    } else {
        $SysPy = Find-Python
        Write-Output ("setup: no bundled python - building a venv with {0}" -f $SysPy)
        if (-not (Test-Path $VenvPy)) {
            Write-Output 'setup: creating venv'
            & $SysPy -m venv $Venv
        }
        Write-Output 'setup: installing dependencies'
        & $VenvPy -m pip install --quiet --upgrade pip
        & $VenvPy -m pip install --quiet -r (Join-Path $Server 'requirements.in')
    }
    & $VenvPy -c "import fastapi, uvicorn, httpx, pydantic_ai; print('setup: fastapi', fastapi.__version__, 'uvicorn', uvicorn.__version__)"
    if ($LASTEXITCODE -ne 0) { throw 'the interpreter cannot import the dependencies' }

    $target = if ($DataDir) { $DataDir } else { Join-Path $Root 'data' }
    try { New-Item -ItemType Directory -Force $target | Out-Null }
    catch { throw ("cannot create data dir {0}: {1}" -f $target, $_.Exception.Message) }

    if ($DataDir -and ($DataDir -ne (Join-Path $Root 'data'))) {
        # Not Set-Content -Encoding utf8: PowerShell 5.1 writes a BOM with that,
        # and the BOM becomes part of the path the server reads.
        [System.IO.File]::WriteAllText($Pin, $DataDir)
        Write-Output ("setup: pinned data dir in {0}" -f $Pin)
    } else {
        Remove-Item $Pin -ErrorAction SilentlyContinue
    }
    Write-Output ("setup: data dir {0}" -f $target)

    if ($Service) { Install-Service }
    elseif (-not $NoStart) { Start-Server }
    if ($Service -or (-not $NoStart)) { Get-Status; Show-Token }
}

function Start-Server {
    if (-not (Test-Path $VenvPy)) { throw 'no interpreter - run setup first' }
    if (-not (Test-Path $Bat)) { throw "missing $Bat" }
    # Win32_Process.Create runs under the WMI service, outside the ssh session's
    # job object. Start-Process does not: OpenSSH kills the whole job when the
    # session ends, which looks like a successful start that leaves nothing
    # listening. The .bat owns all quoting so this command line needs none.
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = 'cmd.exe /c ' + $Bat + ' ' + $Port
    }
    if ($r.ReturnValue -ne 0) { throw ("Win32_Process.Create returned {0}" -f $r.ReturnValue) }
    Write-Output ("start: pid {0}" -f $r.ProcessId)
    Start-Sleep -Seconds 5
}

function Stop-Server {
    $procs = @(Get-ServerProcesses)
    if ($procs.Count -eq 0) { Write-Output 'stop: nothing running'; return }
    foreach ($p in $procs) {
        try { Stop-Process -Id $p.ProcessId -Force; Write-Output ("stop: killed pid {0}" -f $p.ProcessId) }
        catch {
            # Killing the venv launcher takes its child with it, and the child
            # can disappear between the look and the kill. Gone is what we
            # wanted either way.
            if (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue) {
                Write-Output ("stop: could not kill {0}: {1}" -f $p.ProcessId, $_.Exception.Message)
            } else {
                Write-Output ("stop: pid {0} exited with its parent" -f $p.ProcessId)
            }
        }
    }
}

function Install-Service {
    if (-not (Test-Admin)) {
        throw 'registering a service needs an elevated PowerShell. Re-run setup.bat as administrator, or drop -Service and start it by hand.'
    }
    $exe = Find-Nssm
    if (-not $exe) {
        throw @'
nssm.exe not found.

  winget install NSSM.NSSM
  choco install nssm
  or download it from https://nssm.cc

Without it, start.bat works on its own - the restart loop is in it, not in the
supervisor.
'@
    }
    if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
        throw "a service called $Name already exists. Remove it first: uninstall.bat"
    }
    Write-Output ("service: using {0}" -f $exe)

    # cmd.exe with AppDirectory set, and a bare relative start.bat: a path with
    # a space would otherwise need quoting that has to survive nssm, the service
    # manager and cmd in turn.
    #
    # The service runs start.bat, never run.py. Exit 75 means "an update was
    # installed, come back up", and the loop that understands it is in the
    # launcher; a supervisor pointed straight at run.py works right up until the
    # day someone updates from the plugin.
    & $exe install $Name 'cmd.exe' | Out-Null
    & $exe set $Name AppDirectory $Server | Out-Null
    & $exe set $Name AppParameters ("/c start.bat {0}" -f $Port) | Out-Null
    & $exe set $Name DisplayName ("Risu Hina backend ({0})" -f $Port) | Out-Null
    & $exe set $Name Description 'RisuAI chat post-editing backend' | Out-Null
    & $exe set $Name Start SERVICE_AUTO_START | Out-Null
    # A crash loop should be a slow one rather than a hot spin. The launcher
    # exits for real on anything that is not 75, so this is the crash path.
    & $exe set $Name AppThrottle 5000 | Out-Null
    & $exe set $Name AppExit Default Restart | Out-Null
    & $exe set $Name AppRestartDelay 5000 | Out-Null
    & $exe start $Name | Out-Null
    Write-Output ("service: installed and started {0}" -f $Name)
    Start-Sleep -Seconds 5
}

function Uninstall-Service {
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $svc) { Write-Output 'service: nothing registered'; return }
    if (-not (Test-Admin)) { throw 'removing a service needs an elevated PowerShell' }
    $exe = Find-Nssm
    if ($svc.Status -ne 'Stopped') {
        if ($exe) { & $exe stop $Name | Out-Null } else { Stop-Service -Name $Name -Force }
        # The manager reports Stopped before the child cmd.exe and its python
        # have gone; removing while they linger leaves a service marked for
        # deletion that a reinstall then collides with.
        for ($i = 0; $i -lt 15; $i++) {
            Start-Sleep -Seconds 1
            $s = Get-Service -Name $Name -ErrorAction SilentlyContinue
            if (-not $s -or $s.Status -eq 'Stopped') { break }
        }
    }
    if ($exe) { & $exe remove $Name confirm | Out-Null } else { & sc.exe delete $Name | Out-Null }
    Start-Sleep -Seconds 2
    if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
        Write-Output ("service: {0} is still registered." -f $Name)
        Write-Output 'Windows keeps a service marked for deletion until every handle closes -'
        Write-Output 'close services.msc and the Task Manager services tab, then check again.'
    } else {
        Write-Output ("service: removed {0}" -f $Name)
    }
}

function Invoke-Uninstall {
    Uninstall-Service
    Stop-Server
    if ($Purge) {
        $data = Get-DataDir
        Write-Output ''
        Write-Output 'purging:'
        Write-Output ("  {0}" -f $Venv)
        Write-Output ("  {0}" -f $data)
        if (Test-Path $Venv) { Remove-Item -Recurse -Force $Venv -ErrorAction SilentlyContinue }
        Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue
        Remove-Item $Pin -ErrorAction SilentlyContinue
        Write-Output 'purged. The code is still here; delete this folder to finish.'
    } else {
        Write-Output ''
        Write-Output 'nothing deleted. To also remove the venv and the data:  uninstall.bat -Purge'
        Write-Output 'Your RisuAI chats are untouched either way - this tool only ever wrote'
        Write-Output 'back edits you approved.'
    }
}

function Get-Status {
    Write-Output ("install    {0}" -f $Root)
    Write-Output ("data       {0}" -f (Get-DataDir))
    $procs = @(Get-ServerProcesses)
    # One process with the bundled interpreter. Two with a venv, and that is
    # not a duplicate server: a venv's Scripts\python.exe is venvlauncher.exe,
    # which starts the real interpreter as a child and stays as its parent.
    $expected = if (Test-Path $BundledPy) { 1 } else { 2 }
    $note = if ($procs.Count -eq 2 -and $expected -eq 2) { ' (venv launcher + server, normal)' }
            elseif ($procs.Count -gt $expected) { ' - more than expected' }
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
    if (Test-Path $t) {
        Write-Output ''
        Write-Output ("token (only needed from another machine): {0}" -f (Get-Content $t -Raw).Trim())
    }
}

switch ($Action) {
    'setup'     { Invoke-Setup }
    'uninstall' { Invoke-Uninstall }
    'start'     { Start-Server; Get-Status }
    'stop'      { Stop-Server }
    'restart'   { Stop-Server; Start-Sleep -Seconds 1; Start-Server; Get-Status }
    'status'    { Get-Status }
    'token'     { Show-Token }
}
