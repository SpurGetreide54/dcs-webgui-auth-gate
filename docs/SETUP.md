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
- NSSM itself (public domain, see `nssm.cc`) is vendored at
  `scripts/windows/nssm.exe` and ships in the agent release zip next to
  `install.ps1`, which uses it straight off disk when its checksum
  matches. nssm.cc is a small, flaky site that's 503'd on us before, so
  this reuses a copy we already fetched and verified once instead of
  hitting it again on every install -- being resourceful with what we
  already have, not hammering it needlessly. It only falls back to
  downloading a fresh copy from nssm.cc when the vendored one is missing
  or its checksum doesn't match.
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

### auth-gate: one-time migration (on the VM, over SSH)

1. Add the shared `WEBGUI_STATIC_PATH` and `ACTIVE_SLOT_PATH` lines to
   `.env` if they aren't already there. Without the first, each A/B slot
   would look for its own, empty `webgui-static/` instead of the real one
   (see the "Values that must match" note above). Without the second, each
   slot's own code defaults to looking for `active-slot` *inside itself*
   (`src/activeSlot.js`'s own fallback, meant for a plain single-checkout
   local dev setup) instead of the shared top-level file `launcher.js`
   reads -- an update would stage and "flip" without error, but the flip
   would land somewhere the launcher never looks, so it would keep
   launching the old slot forever:
   ```
   echo 'WEBGUI_STATIC_PATH=/var/www/dcs-webgui-auth-gate/webgui-static' | sudo tee -a /var/www/dcs-webgui-auth-gate/.env
   echo 'ACTIVE_SLOT_PATH=/var/www/dcs-webgui-auth-gate/active-slot' | sudo tee -a /var/www/dcs-webgui-auth-gate/.env
   ```
2. Create the two slot directories and seed slot A with the code already
   running (so the very first update has something real to diff against,
   and the app keeps working if you stop here):
   ```
   cd /var/www/dcs-webgui-auth-gate
   sudo mkdir -p releases/a releases/b
   sudo rsync -a --exclude releases --exclude local-only --exclude webgui-static --exclude node_modules . releases/a/
   sudo cp -r node_modules releases/a/
   sudo chown -R dcs-webgui-auth-gate:dcs-webgui-auth-gate releases
   echo -n a | sudo tee active-slot
   sudo cp scripts/systemd/dcs-webgui-auth-gate.service scripts/systemd/dcs-webgui-auth-gate-rollback.service /tmp/
   ```
3. Copy `launcher.js` to the top level (it's not part of either slot --
   see its own top comment for why) and install the two unit files from
   this repo (`scripts/systemd/dcs-webgui-auth-gate.service` replaces the
   existing unit; `dcs-webgui-auth-gate-rollback.service` is new):
   ```
   sudo cp /tmp/dcs-webgui-auth-gate.service /tmp/dcs-webgui-auth-gate-rollback.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl restart dcs-webgui-auth-gate
   ```
4. Confirm it came back up running from the new launcher: `systemctl
   status dcs-webgui-auth-gate` should show it active, and the app should
   still be reachable normally. From here on, `/admin/update` handles
   updates -- this whole migration never needs repeating.

### mission-agent: one-time migration (on the DCS host)

Re-run `install.ps1` once (see its own `-Confirm`-free idempotent-reinstall
behavior, described in its header comment). The updated script now copies
`agent.exe` into `releases\a\` and points a `current` junction at it,
instead of placing it directly in the install directory -- NSSM's own
config ends up targeting `current\agent.exe`, a path that never changes
again across future updates.

```
.\install.ps1 -DcsSavedGamesRoot "C:\Users\dcsservice\Saved Games"
```

Safe to re-run with the same parameters as before; see the script's own
`.DESCRIPTION` for exactly what changes and what doesn't.

### Release process (cutting a new version)

1. Bump `package.json`'s (and `VERSION`'s) version, build both artifacts
   as usual (`scripts/build-agent-exe.sh` for the agent; the auth-gate's
   own artifact is a `tar.gz` of the repo, `node_modules` included, matching
   what `src/updateCheck.js` extracts with the `tar` package already a
   dependency).
2. Sign the release:
   ```
   node scripts/release/sign-updates.js \
     --version 1.2-alpha \
     --changelog-url https://github.com/SpurGetreide54/dcs-webgui-auth-gate/releases/tag/1.2-alpha \
     --auth-gate local-only/release/auth-gate/auth-gate-1.2-alpha.tar.gz \
     --agent local-only/release/agent/agent-1.2-alpha.exe
   ```
   Needs `local-only/keys/update-signing-key.pem` -- generate one once with
   `node -e "require('crypto').generateKeyPairSync('ed25519')"`-style code
   if it doesn't exist yet, and hardcode the matching public key into
   `src/updateCheck.js`'s `PUBLIC_KEY_PEM`. Never commit the private key.
3. Also build two `.zip`s for manual deployment -- neither is part of the
   signed manifest or touched by the self-update code; both exist only for
   a human installing by hand, e.g. a from-scratch install or seeding a
   slot directly instead of the rsync steps above:
   - auth-gate: same contents as the `.tar.gz` (`node_modules` included,
     same excludes), just a different container for whoever would rather
     not use `tar`.
   - agent: `agent.exe` alongside `install.ps1`, `uninstall.ps1`,
     `scripts/windows/nssm.exe`, `VERSION`, `DISCLAIMER`, and `LICENSE` --
     everything `install.ps1` needs to run standalone on a DCS host that
     has no git clone of this repo at all, and reusing the vendored
     nssm.exe instead of making every install hit nssm.cc itself.
4. Create the GitHub Release by hand (tag matching `--version`/`--tag`),
   and upload both signed artifacts, the generated
   `local-only/release/signed_updates.json`, and both manual-deployment
   `.zip`s as release assets. The two signed artifacts' filenames must
   match what `sign-updates.js` put in the manifest's `downloads[].url`
   fields; the `.zip`s' names are unconstrained since nothing parses them.
