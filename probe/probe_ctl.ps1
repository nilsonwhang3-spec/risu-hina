# Phase 0 probe control for test-server.
#
# ASCII only, on purpose: PowerShell 5.1 reads a BOM-less UTF-8 .ps1 as the
# system ANSI codepage, so Korean text in a script silently turns to mojibake.
# Nothing here needs non-ASCII, so the trap is avoided rather than worked around.
#
# It also exists because ssh -> cmd -> powershell quoting mangles pipes and
# nested quotes; running a file takes all of that off the command line.
#
#   powershell -ExecutionPolicy Bypass -File probe_ctl.ps1 -Action start -Token <tok>
#   powershell -ExecutionPolicy Bypass -File probe_ctl.ps1 -Action status
#   powershell -ExecutionPolicy Bypass -File probe_ctl.ps1 -Action stop

param(
    [ValidateSet('start', 'stop', 'status', 'restart')]
    [string]$Action = 'status',
    [string]$Token = 'probe-local',
    [int]$Port = 6020
)

$ErrorActionPreference = 'Stop'
$Root = 'D:\code\risu-elf\probe'
$Script = Join-Path $Root 'probe_server.py'
$Log = Join-Path $Root 'out.log'
$Py = 'C:\Program Files\Python311\python.exe'

function Get-ProbeProcesses {
    # -ErrorAction SilentlyContinue would still trip the tool's exit code, so
    # the filter is written to simply return nothing when there is no match.
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*probe_server.py*' }
}

function Stop-Probe {
    $procs = @(Get-ProbeProcesses)
    if ($procs.Count -eq 0) {
        Write-Output 'stop: nothing running'
        return
    }
    foreach ($p in $procs) {
        try {
            Stop-Process -Id $p.ProcessId -Force
            Write-Output ("stop: killed pid {0}" -f $p.ProcessId)
        } catch {
            Write-Output ("stop: could not kill pid {0}: {1}" -f $p.ProcessId, $_.Exception.Message)
        }
    }
}

function Start-Probe {
    if (-not (Test-Path $Script)) { throw "missing $Script" }
    if (-not (Test-Path $Py)) { throw "missing $Py" }

    # Win32_Process.Create runs the process under the WMI service, outside the
    # SSH session's job object. Start-Process does not: OpenSSH kills the whole
    # job when the session ends, which is why an apparently-successful
    # Start-Process left nothing listening.
    # The launcher .bat owns the quoting and its own redirection, so the command
    # line handed to WMI needs no quotes at all - which is what makes it survive
    # cmd's outer-quote-stripping rule.
    $bat = Join-Path $Root 'start_probe.bat'
    if (-not (Test-Path $bat)) { throw "missing $bat" }
    $wrapped = 'cmd.exe /c {0} {1} {2}' -f $bat, $Token, $Port
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $wrapped }
    if ($r.ReturnValue -ne 0) { throw ("Win32_Process.Create returned {0}" -f $r.ReturnValue) }
    Write-Output ("start: pid {0}" -f $r.ProcessId)
    Start-Sleep -Seconds 2
}

function Get-ProbeStatus {
    $procs = @(Get-ProbeProcesses)
    Write-Output ("processes: {0}" -f $procs.Count)
    foreach ($p in $procs) { Write-Output ("  pid {0}" -f $p.ProcessId) }

    # Must match LISTENING specifically: a plain ":6020" match also hits
    # TIME_WAIT rows from a client socket, which reported a live server when
    # nothing was actually bound.
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
            Get-Content $Log -Tail 20 | ForEach-Object { Write-Output $_ }
        }
    }
}

switch ($Action) {
    'start'   { Start-Probe; Get-ProbeStatus }
    'stop'    { Stop-Probe }
    'status'  { Get-ProbeStatus }
    'restart' { Stop-Probe; Start-Sleep -Seconds 1; Start-Probe; Get-ProbeStatus }
}
