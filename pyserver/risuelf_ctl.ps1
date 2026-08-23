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
    [int]$Port = 6020
)

$ErrorActionPreference = 'Stop'
$Root = 'D:\code\risu-elf'
$Server = Join-Path $Root 'pyserver'
$Venv = Join-Path $Server '.venv'
$VenvPy = Join-Path $Venv 'Scripts\python.exe'
$Entry = Join-Path $Server 'run.py'
$Log = Join-Path $Server 'server.log'
$DataDir = Join-Path $Root 'data'
$SysPy = 'C:\Program Files\Python311\python.exe'

function Get-ServerProcesses {
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*risu-elf*run.py*' }
}

function Invoke-Setup {
    if (-not (Test-Path $SysPy)) { throw "missing $SysPy" }
    if (-not (Test-Path $VenvPy)) {
        Write-Output 'setup: creating venv'
        & $SysPy -m venv $Venv
    }
    Write-Output 'setup: installing dependencies'
    & $VenvPy -m pip install --quiet --upgrade pip
    & $VenvPy -m pip install --quiet -r (Join-Path $Server 'requirements.in')
    & $VenvPy -c "import fastapi, uvicorn, httpx; print('setup: fastapi', fastapi.__version__, 'uvicorn', uvicorn.__version__)"
}

function Stop-Server {
    $procs = @(Get-ServerProcesses)
    if ($procs.Count -eq 0) { Write-Output 'stop: nothing running'; return }
    foreach ($p in $procs) {
        try { Stop-Process -Id $p.ProcessId -Force; Write-Output ("stop: killed pid {0}" -f $p.ProcessId) }
        catch { Write-Output ("stop: could not kill {0}: {1}" -f $p.ProcessId, $_.Exception.Message) }
    }
}

function Start-Server {
    if (-not (Test-Path $VenvPy)) { throw "venv missing - run -Action setup first" }
    # Win32_Process.Create runs under the WMI service, outside the SSH session's
    # job object. Start-Process does not: OpenSSH kills the whole job when the
    # session ends, which looks like a successful start that leaves nothing
    # listening. The .bat owns all quoting so this command line needs none.
    $bat = Join-Path $Server 'start.bat'
    if (-not (Test-Path $bat)) { throw "missing $bat" }
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = 'cmd.exe /c ' + $bat + ' ' + $Port
    }
    if ($r.ReturnValue -ne 0) { throw ("Win32_Process.Create returned {0}" -f $r.ReturnValue) }
    Write-Output ("start: pid {0}" -f $r.ProcessId)
    Start-Sleep -Seconds 4
}

function Get-Status {
    $procs = @(Get-ServerProcesses)
    Write-Output ("processes: {0}" -f $procs.Count)
    foreach ($p in $procs) { Write-Output ("  pid {0}" -f $p.ProcessId) }

    # Must match LISTENING specifically: a bare ":6020" also matches TIME_WAIT
    # rows from a client socket and reports a live server when nothing is bound.
    $listening = @(netstat -ano -p tcp |
        Select-String -SimpleMatch 'LISTENING' |
        Select-String -SimpleMatch ("127.0.0.1:{0}" -f $Port))
    Write-Output ("listening on {0}: {1}" -f $Port, $listening.Count)

    try {
        $res = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri ("http://127.0.0.1:{0}/health" -f $Port)
        Write-Output ("health: {0}" -f $res.Content)
    } catch {
        Write-Output ("health: unreachable ({0})" -f $_.Exception.Message)
        if (Test-Path $Log) {
            Write-Output '--- log tail ---'
            Get-Content $Log -Tail 25 | ForEach-Object { Write-Output $_ }
        }
    }
}

function Show-Token {
    $t = Join-Path $DataDir 'token.txt'
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
