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

Two pieces deploy to two different machines.<br>See the main README for what
each one does.

### auth-gate

Deploy on a control-panel VM, behind a reverse proxy.

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

## A/B self-update

Both pieces can update themselves: the auth-gate checks GitHub hourly for
a new signed release, and a site admin triggers the actual update from
`/admin/update` (a sidebar icon lights up when one's available). Updating
stages the new version into whichever "slot" (A or B) isn't currently
running, then restarts into it; a version that fails to start gets rolled
back automatically. See `src/updateCheck.js`'s top comment for the full
design.

This needs a one-time manual migration on each side before it works --
deliberately not automated, since it changes how the service itself is
supervised. Routine updates after that need no further manual steps.

### Release process (cutting a new version)

1. Bump `package.json`'s (and `VERSION`'s) version, build both artifacts
   as usual (`scripts/build-agent-exe.sh` for the agent; the auth-gate's
   own artifact is a `tar.gz` of the repo, `node_modules` included, matching
   what `src/updateCheck.js` extracts with the `tar` package already a
   dependency).
2. Sign the release:
   ```
   node scripts/release/sign-updates.js \
     --version 1.2.0 \
     --changelog-url https://github.com/SpurGetreide54/dcs-webgui-auth-gate/releases/tag/1.2.0 \
     --auth-gate local-only/release/auth-gate/auth-gate-1.2.0.tar.gz \
     --agent local-only/release/agent/agent-1.2.0.exe
   ```
   Needs `local-only/keys/update-signing-key.pem` -- generate one once with
   `node -e "require('crypto').generateKeyPairSync('ed25519')"`-style code
   if it doesn't exist yet, and hardcode the matching public key into
   `src/updateCheck.js`'s `PUBLIC_KEY_PEM`. Never commit the private key.
3. Create the GitHub Release by hand (tag matching `--version`/`--tag`),
   and upload both artifacts plus the generated
   `local-only/release/signed_updates.json` as release assets, with
   filenames matching what `sign-updates.js` put in the manifest's
   `downloads[].url` fields.
