# Installation

For what each process does, see [Architecture](Architecture.md).<br>For
where each process runs, see [Deployment Topology](Deployment-Topology.md)
first.<br>"VM" and "physical host" below refer to that topology.

Use a release build for both processes. Building from source is a
maintainer concern, not a normal install step.

## auth-gate

1. Download the latest auth-gate release
   ([GitHub Releases](https://github.com/SpurGetreide54/dcs-webgui-auth-gate/releases)),
   `.tar.gz` or `.zip`. It already includes `node_modules`. No build
   step.
2. Unpack it on the VM.
3. Copy `.env.example` to `.env` and fill it in. See
   [Configuration](Configuration.md).
4. Set `COOKIE_SECURE=true`. It needs real HTTPS, from a reverse
   proxy in front. See [Deployment Topology](Deployment-Topology.md).
5. On the reverse proxy, add a second server block for
   `WEBGUI_CONTROL_PORT` (default 8088), with its own TLS passthrough.
   The browser dials this port directly. See
   [Architecture](Architecture.md) for why.
6. Start it. The next step sets it up as a supervised service. See
   [A/B Self-Update](A-B-Self-Update.md).

## mission-agent

1. Download the latest agent release
   ([GitHub Releases](https://github.com/SpurGetreide54/dcs-webgui-auth-gate/releases)),
   a `.zip` with `agent.exe`, `install.ps1`, `uninstall.ps1`, and a
   vendored `nssm.exe`. No build step.
2. Unpack it on the physical host.
3. Install it as a Windows service:
   ```
   .\install.ps1
   ```
   This wraps `agent.exe` with NSSM, so Windows restarts it on crash
   and on boot. Defaults to the installing user's own "Saved Games"
   folder; pass `-DcsSavedGamesRoot "C:\Users\dcsservice\Saved Games"`
   instead when DCS runs under a dedicated account.
4. Bind it only to the interface reachable from the auth-gate VM.
   Keep it off the host's internet-facing side.
5. Read the generated token, and copy it into the auth-gate's
   `MISSION_AGENT_TOKEN`:
   ```
   Get-Content "C:\Program Files\dcs-webgui-agent\agent-token.txt"
   ```
   This file is the only place the token appears.

### Windows Firewall

`install.ps1` creates two program rules automatically,
`DcsWebguiAgent-SlotA` and `DcsWebguiAgent-SlotB`, each pointed at one
A/B slot's real resolved path (`releases\a\agent.exe` and
`releases\b\agent.exe`). `uninstall.ps1` removes both. No manual step
needed.

`current` is a directory junction, a symlink-style path.<br>Windows
Firewall does not match a program-path rule against a symlink path,
which is why there are two per-slot rules instead of one pointed at
`current\agent.exe`.<br>Whichever slot `current` points at next, a
matching rule is already there. See
[FAQ](FAQ.md#why-does-a-windows-firewall-rule-need-two-copies-one-per-slot).

## Values that must match on both sides

| Value | Rule |
|---|---|
| `MISSION_AGENT_TOKEN` | Identical on both sides. The agent generates it in production. You choose it yourself in local development. |
| `instance_name` (set per server in `/admin/servers`) | Must match the real DCS instance folder name under `Saved Games` on the physical host. |
| `dcs_install_path` (optional, set per server) | Only needed to offer that server as a source on `/admin/servers/webgui-sync`. |

See [Configuration](Configuration.md) for every environment variable.

## Next step

New deployments also need the one-time A/B self-update setup. See
[A/B Self-Update](A-B-Self-Update.md).
