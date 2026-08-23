<#
.SYNOPSIS
  Uninstalls the dcs-webgui-agent Windows Service and removes its files.

.DESCRIPTION
  Symmetric with install.ps1. Stops the service, removes its registration
  via NSSM, and deletes the install directory (agent.exe, nssm.exe, and the
  log file). Safe to run even if the service was never installed.

.EXAMPLE
  .\uninstall.ps1
#>

#Requires -RunAsAdministrator

param(
    [string]$InstallDir = "C:\Program Files\dcs-webgui-agent",
    [string]$ServiceName = "DcsWebguiAgent"
)

$ErrorActionPreference = "Stop"

$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Host "==> Stopping service $ServiceName"
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue

    $nssmExePath = "$InstallDir\nssm.exe"
    if (Test-Path $nssmExePath) {
        Write-Host "==> Removing service $ServiceName via NSSM"
        & $nssmExePath remove $ServiceName confirm | Out-Null
    } else {
        Write-Host "==> nssm.exe not found in $InstallDir, falling back to sc.exe delete"
        & sc.exe delete $ServiceName | Out-Null
    }
} else {
    Write-Host "==> Service $ServiceName not found, nothing to stop"
}

if (Test-Path $InstallDir) {
    Write-Host "==> Removing $InstallDir"
    Remove-Item -Path $InstallDir -Recurse -Force
}

Write-Host "==> Done. Service and files removed."
