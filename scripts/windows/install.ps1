<#
.SYNOPSIS
  Installs dcs-webgui-agent as a Windows Service, on the same machine that
  runs the DCS server(s) it's paired with.

.DESCRIPTION
  Copies agent.exe into a fixed install directory. Downloads and checksum-
  verifies a pinned NSSM release to wrap it as a proper Windows Service --
  starts before any login, restarts itself on crash. Sets the required
  config as service-scoped environment variables, and starts it. No UI.
  Status/output goes to a plain rotating log file. Check Get-Service or the
  log instead.

  Safe to re-run. An existing service with the same name is stopped and
  removed first, so changing config is just running install.ps1 again with
  new parameters, or uninstall.ps1 then install.ps1.

.PARAMETER MissionAgentToken
  Shared bearer token the auth-gate uses to authenticate to this agent.
  Optional -- omit it and the agent generates its own on first start,
  saved to agent-token.txt in the install directory. Read that file to get
  the value, then set MISSION_AGENT_TOKEN to match on the auth-gate side.
  Pass this parameter only to pin a specific value instead (e.g.
  restoring a known-good token).

.PARAMETER DcsSavedGamesRoot
  Path to the Windows user's "Saved Games" folder that holds every DCS
  instance directory, e.g. C:\Users\dcsservice\Saved Games

.PARAMETER AgentPort
  Port the agent listens on. Must match MISSION_AGENT_URL's port on the
  auth-gate side.

.PARAMETER AgentExePath
  Path to the built agent.exe (see scripts/build-agent-exe.sh, run elsewhere
  and copied to this host). Defaults to agent.exe sitting next to this script.

.EXAMPLE
  .\install.ps1 -DcsSavedGamesRoot "C:\Users\dcsservice\Saved Games"

.EXAMPLE
  .\install.ps1 -MissionAgentToken "long-random-token" -DcsSavedGamesRoot "C:\Users\dcsservice\Saved Games"
#>

#Requires -RunAsAdministrator

param(
    [string]$MissionAgentToken = "",
    [Parameter(Mandatory=$true)][string]$DcsSavedGamesRoot,
    [int]$AgentPort = 4000,
    [string]$AgentExePath = "$PSScriptRoot\agent.exe",
    [string]$InstallDir = "C:\Program Files\dcs-webgui-agent",
    [string]$ServiceName = "DcsWebguiAgent"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $AgentExePath)) {
    throw "agent.exe not found at '$AgentExePath'. Build it first (scripts/build-agent-exe.sh) and copy it next to this script, or pass -AgentExePath."
}
if (-not (Test-Path $DcsSavedGamesRoot)) {
    throw "DcsSavedGamesRoot '$DcsSavedGamesRoot' does not exist."
}

Write-Host "==> Creating install directory $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Write-Host "==> Copying agent.exe"
Copy-Item -Path $AgentExePath -Destination "$InstallDir\agent.exe" -Force

# NSSM pinned to the 2.24 stable release. Checksum verified once against
# the real nssm.cc download and pinned here, not trusted fresh on every
# install run.
$NssmUrl = "https://nssm.cc/release/nssm-2.24.zip"
$NssmSha256 = "727D1E42275C605E0F04ABA98095C38A8E1E46DEF453CDFFCE42869428AA6743"
$NssmZip = "$env:TEMP\nssm-2.24.zip"
$NssmExtractDir = "$env:TEMP\nssm-2.24-extract"
$NssmExePath = "$InstallDir\nssm.exe"

if (-not (Test-Path $NssmExePath)) {
    Write-Host "==> Downloading NSSM"
    Invoke-WebRequest -Uri $NssmUrl -OutFile $NssmZip

    $actualHash = (Get-FileHash -Path $NssmZip -Algorithm SHA256).Hash
    if ($actualHash -ne $NssmSha256) {
        Remove-Item -Path $NssmZip -Force -ErrorAction SilentlyContinue
        throw "NSSM download checksum mismatch: expected $NssmSha256, got $actualHash. Refusing to install a tampered or corrupted binary."
    }

    Write-Host "==> Extracting NSSM"
    Expand-Archive -Path $NssmZip -DestinationPath $NssmExtractDir -Force
    Copy-Item -Path "$NssmExtractDir\nssm-2.24\win64\nssm.exe" -Destination $NssmExePath -Force
    Remove-Item -Path $NssmZip, $NssmExtractDir -Recurse -Force -ErrorAction SilentlyContinue
}

# Idempotent re-install. Tear down any prior registration under this name
# first, so changing config is just re-running this script.
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Host "==> Existing service found, stopping and removing before reinstall"
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    & $NssmExePath remove $ServiceName confirm | Out-Null
}

Write-Host "==> Registering service $ServiceName"
& $NssmExePath install $ServiceName "$InstallDir\agent.exe"
& $NssmExePath set $ServiceName AppDirectory $InstallDir

# NSSM's AppEnvironmentExtra takes one KEY=VALUE pair per line, as a single
# parameter value -- not separate command-line arguments. MISSION_AGENT_TOKEN
# is only included when explicitly passed in. Left out, agent.js generates
# and persists its own on first start.
$envLines = @("DCS_SAVED_GAMES_ROOT=$DcsSavedGamesRoot", "AGENT_PORT=$AgentPort")
if ($MissionAgentToken) {
    $envLines += "MISSION_AGENT_TOKEN=$MissionAgentToken"
}
& $NssmExePath set $ServiceName AppEnvironmentExtra ($envLines -join "`n")

& $NssmExePath set $ServiceName AppStdout "$InstallDir\agent.log"
& $NssmExePath set $ServiceName AppStderr "$InstallDir\agent.log"
& $NssmExePath set $ServiceName AppRotateFiles 1
& $NssmExePath set $ServiceName AppRotateOnline 1
& $NssmExePath set $ServiceName AppRotateBytes 10485760
& $NssmExePath set $ServiceName Start SERVICE_AUTO_START
& $NssmExePath set $ServiceName AppExit Default Restart
& $NssmExePath set $ServiceName AppRestartDelay 5000

Write-Host "==> Starting service"
Start-Service -Name $ServiceName

Write-Host "==> Done. Service '$ServiceName' is running."
Write-Host "    Status:  Get-Service $ServiceName"
Write-Host "    Log:     $InstallDir\agent.log"
Write-Host "    Remove:  uninstall.ps1"
if (-not $MissionAgentToken) {
    Write-Host "    Token:   Get-Content $InstallDir\agent-token.txt"
    Write-Host "             Set this as MISSION_AGENT_TOKEN on the auth-gate side."
}
