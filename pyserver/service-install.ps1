# Register the backend as a Windows service, using NSSM.
#
#   powershell -ExecutionPolicy Bypass -File service-install.ps1
#   powershell -ExecutionPolicy Bypass -File service-install.ps1 -Name MyElf -Port 6030
#
# The service runs start.bat, not run.py directly. That matters: exit code 75
# means "an update was installed, come back up", and the loop that understands
# it lives in the launcher. Pointing a supervisor straight at run.py works
# until the day someone updates from the plugin, and then it stops silently.
#
# Run this from an elevated prompt - creating a service needs it.
param(
    [string]$Name = 'RisuElf',
    [int]$Port = 6020,
    # Where nssm.exe is, if it is not on PATH or in the usual places.
    [string]$Nssm = ''
)

$ErrorActionPreference = 'Stop'

function Unquote([string]$v) {
    if (-not $v) { return $v }
    return $v.Trim().Trim("'").Trim('"')
}
$Nssm = Unquote $Nssm
$Name = Unquote $Name

# This script ships at the install root, next to start.bat.
$Root = $PSScriptRoot
$Bat = Join-Path $Root 'start.bat'
if (-not (Test-Path $Bat)) { throw "cannot find start.bat next to this script ($Root)" }

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'run this from an elevated PowerShell - creating a service requires it'
}

function Find-Nssm {
    if ($Nssm) {
        if (-not (Test-Path $Nssm)) { throw "no nssm.exe at $Nssm" }
        return $Nssm
    }
    $onPath = Get-Command nssm -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    foreach ($p in @(
        'C:\nssm\nssm.exe',
        'C:\Program Files\nssm\nssm.exe',
        'C:\ProgramData\chocolatey\bin\nssm.exe',
        "$env:LOCALAPPDATA\Microsoft\WinGet\Links\nssm.exe")) {
        if (Test-Path $p) { return $p }
    }
    throw @'
nssm.exe not found.

  winget install NSSM.NSSM
  choco install nssm
  or download from https://nssm.cc and pass -Nssm <path to nssm.exe>

If you would rather not use NSSM at all, start.bat works on its own - the
restart loop is in it, not in the supervisor.
'@
}

$exe = Find-Nssm
Write-Output ("using {0}" -f $exe)

$existing = Get-Service -Name $Name -ErrorAction SilentlyContinue
if ($existing) {
    throw "a service called $Name already exists. Remove it first: service-uninstall.ps1 -Name $Name"
}

# cmd.exe with AppDirectory set, and a bare relative start.bat: a path with a
# space in it would otherwise need quoting that has to survive nssm, the
# service manager and cmd in turn.
& $exe install $Name 'cmd.exe' | Out-Null
& $exe set $Name AppDirectory $Root | Out-Null
& $exe set $Name AppParameters ("/c start.bat {0}" -f $Port) | Out-Null
& $exe set $Name DisplayName ("Risu Elf backend ({0})" -f $Port) | Out-Null
& $exe set $Name Description 'RisuAI chat post-editing backend' | Out-Null
& $exe set $Name Start SERVICE_AUTO_START | Out-Null

# No AppStdout/AppStderr on purpose: start.bat already writes server.log, and a
# second copy is one nobody reads. Leaving them unset is the default - passing
# an empty string makes nssm print its usage text instead.

# A crash loop should be visible as a slow one rather than a hot spin. The
# launcher exits for real on anything that is not 75, so this is the crash path.
& $exe set $Name AppThrottle 5000 | Out-Null
& $exe set $Name AppExit Default Restart | Out-Null
& $exe set $Name AppRestartDelay 5000 | Out-Null

Write-Output ("installed service {0}" -f $Name)
& $exe start $Name | Out-Null
Start-Sleep -Seconds 5

$svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
Write-Output ("status: {0}" -f $(if ($svc) { $svc.Status } else { 'not found' }))
try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri ("http://127.0.0.1:{0}/health" -f $Port)
    Write-Output ("health: {0}" -f $r.Content)
} catch {
    Write-Output ("health: unreachable yet ({0})" -f $_.Exception.Message)
    $log = Join-Path $Root 'pyserver\server.log'
    if (Test-Path $log) {
        Write-Output '--- log tail ---'
        Get-Content $log -Tail 20 | ForEach-Object { Write-Output $_ }
    }
}

Write-Output ''
Write-Output ("manage it with:  nssm start|stop|restart|status {0}" -f $Name)
Write-Output ("remove it with:  service-uninstall.ps1 -Name {0}" -f $Name)
