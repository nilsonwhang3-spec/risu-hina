# Remove the Windows service, leaving the install and its data alone.
#
#   powershell -ExecutionPolicy Bypass -File service-uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File service-uninstall.ps1 -Name MyElf
#
# This unregisters the service and nothing else. The code stays, the data stays,
# and start.bat still works by hand. Deleting the install is a separate,
# deliberate act - see docs/05-install.md.
param(
    [string]$Name = 'RisuElf',
    [string]$Nssm = ''
)

$ErrorActionPreference = 'Stop'

function Unquote([string]$v) {
    if (-not $v) { return $v }
    return $v.Trim().Trim("'").Trim('"')
}
$Nssm = Unquote $Nssm
$Name = Unquote $Name

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'run this from an elevated PowerShell - removing a service requires it'
}

$svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Output ("no service called {0} - nothing to remove" -f $Name)
    return
}

function Find-Nssm {
    if ($Nssm) { return $Nssm }
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

$exe = Find-Nssm

if ($svc.Status -ne 'Stopped') {
    Write-Output 'stopping...'
    if ($exe) { & $exe stop $Name | Out-Null } else { Stop-Service -Name $Name -Force }
    # The service manager reports Stopped before the child cmd.exe and its
    # python have actually gone; removing while they linger leaves a service
    # marked for deletion that a reinstall then collides with.
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        $s = Get-Service -Name $Name -ErrorAction SilentlyContinue
        if (-not $s -or $s.Status -eq 'Stopped') { break }
    }
}

if ($exe) {
    & $exe remove $Name confirm | Out-Null
} else {
    # No nssm to hand. sc.exe removes the registration just as well; it simply
    # cannot have created it.
    & sc.exe delete $Name | Out-Null
}

Start-Sleep -Seconds 2
$after = Get-Service -Name $Name -ErrorAction SilentlyContinue
if ($after) {
    Write-Output ("{0} is still registered (status {1})." -f $Name, $after.Status)
    Write-Output 'Windows keeps a service marked for deletion until every handle to it closes -'
    Write-Output 'close services.msc and any Task Manager services tab, then check again.'
} else {
    Write-Output ("removed service {0}" -f $Name)
}

Write-Output ''
Write-Output 'the install and its data are untouched. start.bat still works by hand.'
