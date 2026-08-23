# Setup

This covers local development and production deployment. For what this
project is and why it exists, see the main [README](../README.md).

## Local development

1. Run `npm install`.
2. Copy `.env.example` to your own env file, and fill in real values.

This app reads config only from `process.env`. It does not load an env
file on its own. Whatever starts the process must export those variables
first. For example, in a POSIX shell:

```
set -a
. ./my.env
set +a
npm start
```

3. Start the auth-gate: `npm start`. It listens on `PORT` (default 3000).
4. Start the mission-agent separately, with its own env vars:
   ```
   AGENT_PORT=4000 MISSION_AGENT_TOKEN=... DCS_SAVED_GAMES_ROOT=/tmp/saved-games npm run agent
   ```
5. Open `/setup` to create the first admin account. Then use
   `/admin/servers` to add servers.
6. Copy a real DCS webgui bundle into `webgui-static/`, or use
   `/admin/servers/webgui-sync` to pull one from a configured server's
   real DCS install.

## Production deployment

Two pieces deploy to two different machines. See the main README for what
each one does.

### auth-gate

Deploy on a control-panel VM, behind an nginx reverse proxy (see the
sibling `dcs-webgui-reverse-proxy` repo).

- Keep `COOKIE_SECURE=true`. The session cookie needs the HTTPS the
  reverse proxy provides.
- The reverse proxy needs a second server block for `WEBGUI_CONTROL_PORT`
  (default 8088). The browser dials this port directly for DCS
  control-port traffic, so it needs its own TLS-terminated passthrough,
  alongside the main `/` block.
- This port is browser-facing, not agent traffic. The real DCS webgui's
  own JS insists on reaching its backend directly, so the auth-gate
  redirects that traffic here, on the VM itself. From here, the auth-gate
  relays it on to the agent over a separate, internal-only connection —
  see mission-agent below.

### mission-agent

Deploy on the physical Windows host running the DCS gameservers.

- Ships as a standalone `agent.exe` (see `scripts/build-agent-exe.sh`).
- Installs as a Windows Service via `scripts/windows/install.ps1`. This
  script uses NSSM (Non-Sucking Service Manager) to do it. NSSM wraps a
  plain `.exe` so Windows can run it as a real service: start on boot,
  restart on crash, stop and start through `services.msc`. Without it,
  `agent.exe` would need its own console session to keep running, and
  would die when that session ends.
- Bind it only to an interface reachable from the control-panel VM's
  internal IP. Keep it off the host's internet-facing side.
- Run `install.ps1` without `-MissionAgentToken` and the agent generates
  its own on first start, saved to `agent-token.txt` in the install
  directory. Read that file to get the value:
  ```
  Get-Content "C:\Program Files\dcs-webgui-agent\agent-token.txt"
  ```
  The token never appears in `agent.log` or in `install.ps1`'s own
  output — reading the file is the only way to see it, so this step is
  safe to run on a shared screen. Copy the value into `MISSION_AGENT_TOKEN`
  on the auth-gate side. To pin a specific value instead, pass
  `-MissionAgentToken` explicitly.
- `MISSION_AGENT_TOKEN_FILE` overrides where that generated token gets
  read from and saved to. Only needed to point it somewhere other than
  the install directory — most deployments never set this.

### Values that must match

- `MISSION_AGENT_TOKEN` must be identical on both sides. In production,
  the agent is the source of this value — see above. In local
  development, you choose it yourself, matching whatever you pass to
  `npm run agent`.
- `instance_name` (set per server in `/admin/servers`) must match the real
  DCS instance folder name under `Saved Games` on the physical host.
- `dcs_install_path` is optional. Set it only to offer that server as a
  source on `/admin/servers/webgui-sync`.
