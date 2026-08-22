# dcs-webgui-auth-gate

Per-admin, per-server login gate in front of the DCS webgui control panel
(see the sibling `dcs webgui` project), plus a small companion agent that
lets granted admins upload `.miz` mission files straight into a DCS
server's mission folder.

This does not modify `dcs webgui`'s `index.html`/`app.js`. It's a reverse
proxy that sits in front of the whole thing: unauthenticated requests get a
login page instead of the app; authenticated requests get proxied through
transparently, per-server, based on what that admin was granted access to.

Two processes, from one repo:

- **`src/server.js`** (`npm start`) — the auth-gate itself. Deploy on the
  control-panel VM.
- **`src/agent.js`** (`npm run agent`) — the mission-upload agent. Deploy
  on the physical host, next to the DCS gameservers. Write-only, single
  endpoint, shared-token auth — see the comments in that file for why it's
  kept this minimal.

Full infrastructure/design context is in the plan this was built from:
`~/.claude/plans/eager-jumping-allen.md` on the machine this was written on.

## Why two roles

- **Site admin** (`can_manage_accounts`): manages other admin accounts and
  decides who gets access to which server.
- **Per-server access + upload** (`admin_server_access`): a site admin
  grants each admin access to specific servers individually, and,
  separately, whether they're allowed to upload missions on each one.
  Access to one server implies nothing about any other.

## Local setup

Anything that doesn't get committed (env file, SQLite data, dev scripts)
lives under `local-only/`, gitignored as a single unit.

```
npm install
mkdir -p local-only
cp .env.example local-only/.env    # edit values
npm run seed-servers                 # writes the three DCS Deutschland servers into SQLite
```

Easiest path: `local-only/scripts/devenv.sh {start|stop|status}` runs both
`src/server.js` and `src/agent.js` together, with local-dev defaults for
everything (scratch mission folders, a fixed test token, `COOKIE_SECURE=false`)
so it starts clean with no `local-only/.env` at all — that file only
overrides what you actually want to change. Registered with the `devenv`
skill.

To run either piece by hand instead:

```
npm start                                                                  # auth-gate, :3000
AGENT_PORT=4000 MISSION_AGENT_TOKEN=... MISSION_FOLDER_TRAINING=/tmp/training ... npm run agent
```

## Tests

```
npm test
```

Runs against dummy in-process HTTP servers standing in for a DCS webgui
origin and the mission-agent — see `test/`. This is as far as verification
can go without a real DCS server; the plan's "Verification" section covers
the manual steps needed on the real infrastructure.

## Deployment notes

- **auth-gate** goes on the control-panel VM, behind the nginx reverse
  proxy in the sibling `dcs-webgui-reverse-proxy` repo. `COOKIE_SECURE`
  must stay `true` there — the session cookie relies on the HTTPS the
  reverse proxy provides.
- **mission-agent** goes on the physical Windows host running the DCS
  gameservers. There's no existing Node process supervisor there — run it
  as a Windows service via NSSM or `node-windows`. It must bind only to an
  interface reachable from the control-panel VM's internal IP, never the
  host's internet-facing side.
- Both sides of `MISSION_AGENT_TOKEN` must match exactly.
- `servers.upstream_url` and the mission-agent's `MISSION_FOLDER_*` paths
  are real-environment values — edit `scripts/seed-servers.js` and the
  agent's env vars before deploying, they're placeholders here.
