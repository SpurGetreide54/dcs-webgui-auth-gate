<#
.SYNOPSIS
  Installs dcs-webgui-agent as a Windows Service, on the same machine that
  runs the DCS server(s) it's paired with.

.DESCRIPTION
  Copies agent.exe into releases\a\ under a fixed install directory, and
  points a "current" directory junction at it. Checksum-verifies a pinned
  NSSM build to wrap current\agent.exe as a proper Windows Service --
  starts before any login, restarts itself on crash -- using the nssm.exe
  the release zip vendors next to this script when it matches, instead of
  hitting nssm.cc (a small, flaky site) on every single install; only
  falls back to downloading one from nssm.cc when the vendored copy is
  missing or stale. Sets the required config as service-scoped
  environment variables, and starts it. No UI. Status/output goes to a
  plain rotating log file. Check Get-Service or the log instead.

  The junction is what makes the A/B self-update system work on this side
  (see src/agent.js's "self-update: stage + commit" section): NSSM always
  points at current\agent.exe, a path that never changes, while an update
  flips the junction between releases\a\ and releases\b\ and restarts.
  This script only ever (re)creates the junction pointing at releases\a\
  -- it never touches releases\b\ or an update already staged there.

  Safe to re-run. An existing service with the same name is stopped and
  removed first, so changing config is just running install.ps1 again with
  new parameters, or uninstall.ps1 then install.ps1. Re-running always
  resets the junction back to releases\a\, discarding any staged-but-not-
  yet-active update in releases\b\ -- fine for a config change, but worth
  knowing before re-running this right after an update was staged.

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

.PARAMETER NssmSourcePath
  Path to a vendored nssm.exe to install from, skipping the download from
  nssm.cc entirely when it's present and matches NssmExeSha256. Defaults
  to nssm.exe sitting next to this script -- the release zip ships one
  there (see scripts/windows/nssm.exe in the repo), reusing a copy we
  already fetched and verified once instead of hitting nssm.cc -- a
  small, flaky site that has 503'd on us before -- again on every install.

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

Write-Host "==> Creating install directory $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Write-Host "==> Copying agent.exe into releases\a"
$SlotADir = "$InstallDir\releases\a"
New-Item -ItemType Directory -Force -Path $SlotADir | Out-Null
Copy-Item -Path $AgentExePath -Destination "$SlotADir\agent.exe" -Force

Write-Host "==> Pointing current\ at releases\a"
$CurrentLink = "$InstallDir\current"
if (Test-Path $CurrentLink) { Remove-Item -Path $CurrentLink -Force }
New-Item -ItemType Junction -Path $CurrentLink -Target $SlotADir | Out-Null

# NSSM pinned to the 2.24 stable release. Both checksums verified once
# against the real nssm.cc download and pinned here, not trusted fresh on
# every install run: NssmExeSha256 for the bare win64 binary the release
# zip vendors at NssmSourcePath -- reusing a copy already fetched and
# verified once, rather than hitting nssm.cc (small, flaky, has 503'd on
# us) again on every single install -- and NssmSha256 for the nssm.cc zip
# this falls back to downloading only when that vendored copy is missing
# or stale.
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

# Idempotent re-install. Tear down any prior registration under this name
# first, so changing config is just re-running this script.
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-Host "==> Existing service found, stopping and removing before reinstall"
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    & $NssmExePath remove $ServiceName confirm | Out-Null
}

Write-Host "==> Registering service $ServiceName"
& $NssmExePath install $ServiceName "$CurrentLink\agent.exe"
& $NssmExePath set $ServiceName AppDirectory $InstallDir

# NSSM's AppEnvironmentExtra takes one KEY=VALUE pair per line, as a single
# parameter value -- not separate command-line arguments. MISSION_AGENT_TOKEN
# is only included when explicitly passed in. Left out, agent.js generates
# and persists its own on first start.
#
# MISSION_AGENT_TOKEN_FILE is pinned explicitly here, always -- agent.js's
# own default (next to process.execPath) would otherwise resolve to
# current\agent-token.txt, which the "current" junction makes slot-local
# (releases\a\agent-token.txt today). An update flipping to releases\b\
# would then look like the token got reset, when really the file just got
# left behind in the old slot. Pinning it to the stable top-level
# InstallDir keeps one token file shared across both slots, the same way
# .env is shared (not duplicated) on the auth-gate side.
$envLines = @(
    "DCS_SAVED_GAMES_ROOT=$DcsSavedGamesRoot",
    "AGENT_PORT=$AgentPort",
    "MISSION_AGENT_TOKEN_FILE=$InstallDir\agent-token.txt"
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
