<#
.SYNOPSIS
  Installs dcs-webgui-agent as a Windows Service, on the same machine that
  runs the DCS server(s) it's paired with.

.DESCRIPTION
  Copies agent.exe into releases\a\ under a fixed install directory, and
  points a "current" directory junction at it. Checksum-verifies a pinned
  NSSM build to wrap current\agent.exe as a proper Windows Service, using
  the nssm.exe the release zip vendors next to this script when it
  matches, falling back to downloading one from nssm.cc only when that
  vendored copy is missing or stale. Sets the required config as
  service-scoped environment variables, and starts it. No UI.
  Status/output goes to a plain rotating log file.

  See docs/Why.md#why-does-installps1-only-ever-point-the-junction-at-slot-a
  for why the junction always resets to releases\a\ on every run.

.PARAMETER MissionAgentToken
  Shared bearer token the auth-gate uses to authenticate to this agent.
  Optional, omit it and the agent generates its own on first start, saved
  to agent-token.txt in the install directory. Read that file to get the
  value, then set MISSION_AGENT_TOKEN to match on the auth-gate side. Pass
  this parameter only to pin a specific value instead (e.g. restoring a
  known-good token).

.PARAMETER DcsSavedGamesRoot
  Path to the Windows user's "Saved Games" folder that holds every DCS
  instance directory, e.g. C:\Users\dcsservice\Saved Games. Optional,
  defaults to the installing user's own "Saved Games" folder. Pass this
  explicitly when the service should look under a different account's
  folder instead, e.g. a dedicated dcsservice account DCS actually runs
  under.

.PARAMETER AgentPort
  Port the agent listens on. Must match MISSION_AGENT_URL's port on the
  auth-gate side.

.PARAMETER AgentExePath
  Path to the built agent.exe (see scripts/build-agent-exe.sh, run elsewhere
  and copied to this host). Defaults to agent.exe sitting next to this script.

.PARAMETER NssmSourcePath
  Path to a vendored nssm.exe to install from, skipping the download from
  nssm.cc entirely when it's present and matches NssmExeSha256. Defaults
  to nssm.exe sitting next to this script, the release zip ships one
  there (see scripts/windows/nssm.exe in the repo).

.EXAMPLE
  .\install.ps1

.EXAMPLE
  .\install.ps1 -DcsSavedGamesRoot "C:\Users\dcsservice\Saved Games"

.EXAMPLE
  .\install.ps1 -MissionAgentToken "long-random-token" -DcsSavedGamesRoot "C:\Users\dcsservice\Saved Games"
#>

#Requires -RunAsAdministrator

param(
    [string]$MissionAgentToken = "",
    [string]$DcsSavedGamesRoot = "$env:USERPROFILE\Saved Games",
    [int]$AgentPort = 4000,
    [string]$AgentExePath = "$PSScriptRoot\agent.exe",
    [string]$NssmSourcePath = "$PSScriptRoot\nssm.exe",
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
# a non-blocking hint, not an error, the default is only a guess at
# which account DCS actually runs under
# see docs/Why.md#why-does-dcssavedgamesroot-default-to-the-installing-user
if (-not (Get-ChildItem -Path $DcsSavedGamesRoot -Directory -ErrorAction SilentlyContinue)) {
    Write-Host "==> Warning: DcsSavedGamesRoot '$DcsSavedGamesRoot' has no DCS instance folders yet. If DCS runs under a different account, pass -DcsSavedGamesRoot explicitly."
}

Write-Host "==> Creating install directory $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# stop (not remove yet, nssm isn't resolved until below) any existing
# service before touching releases\a, which a running install already
# has locked, see docs/Why.md#why-does-installps1-stop-the-service-twice
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-Host "==> Existing service found, stopping before reinstall"
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
}

Write-Host "==> Copying agent.exe into releases\a"
$SlotADir = "$InstallDir\releases\a"
New-Item -ItemType Directory -Force -Path $SlotADir | Out-Null
Copy-Item -Path $AgentExePath -Destination "$SlotADir\agent.exe" -Force

Write-Host "==> Pointing current\ at releases\a"
$CurrentLink = "$InstallDir\current"
if (Test-Path $CurrentLink) { Remove-Item -Path $CurrentLink -Force }
New-Item -ItemType Junction -Path $CurrentLink -Target $SlotADir | Out-Null

# nssm pinned to the 2.24 stable release, both checksums verified once
# see docs/Why.md#why-are-both-nssm-checksums-pinned-instead-of-fetched-fresh
$NssmExeSha256 = "F689EE9AF94B00E9E3F0BB072B34CAAF207F32DCB4F5782FC9CA351DF9A06C97"
$NssmUrl = "https://nssm.cc/release/nssm-2.24.zip"
$NssmSha256 = "727D1E42275C605E0F04ABA98095C38A8E1E46DEF453CDFFCE42869428AA6743"
$NssmZip = "$env:TEMP\nssm-2.24.zip"
$NssmExtractDir = "$env:TEMP\nssm-2.24-extract"
$NssmExePath = "$InstallDir\nssm.exe"

if (-not (Test-Path $NssmExePath)) {
    $vendoredIsFresh = (Test-Path $NssmSourcePath) -and
        ((Get-FileHash -Path $NssmSourcePath -Algorithm SHA256).Hash -eq $NssmExeSha256)

    if ($vendoredIsFresh) {
        Write-Host "==> Using vendored nssm.exe, no download needed"
        Copy-Item -Path $NssmSourcePath -Destination $NssmExePath -Force
    } else {
        if (Test-Path $NssmSourcePath) {
            Write-Host "==> Vendored nssm.exe at $NssmSourcePath doesn't match the pinned checksum, falling back to nssm.cc"
        }
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
}

# idempotent reinstall, tear down any prior registration first
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Host "==> Existing service found, stopping and removing before reinstall"
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    & $NssmExePath remove $ServiceName confirm | Out-Null
}

Write-Host "==> Registering service $ServiceName"
& $NssmExePath install $ServiceName "$CurrentLink\agent.exe"
& $NssmExePath set $ServiceName AppDirectory $InstallDir

# nssm's AppEnvironmentExtra takes one key=value pair per line, as a
# single parameter value, not separate command-line arguments
# MISSION_AGENT_TOKEN_FILE/AGENT_LOG_FILE are pinned to the stable
# InstallDir, not agent.js's own slot-relative default, see
# docs/Why.md#why-are-token-and-log-paths-pinned-to-installdir
$envLines = @(
    "DCS_SAVED_GAMES_ROOT=$DcsSavedGamesRoot",
    "AGENT_PORT=$AgentPort",
    "MISSION_AGENT_TOKEN_FILE=$InstallDir\agent-token.txt",
    "AGENT_LOG_FILE=$InstallDir\agent.log"
)
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
