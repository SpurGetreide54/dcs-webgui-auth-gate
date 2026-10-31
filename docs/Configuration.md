# Configuration

Both processes read their config from environment variables.<br>The
auth-gate also reads `.env` in its own working directory.<br>See
`.env.example` for a starting file.

## auth-gate (`src/server.js`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | No | `3000` | |
| `MISSION_AGENT_URL` | Yes | none | Base URL of the mission-agent. |
| `MISSION_AGENT_TOKEN` | Yes | none | Must match the mission-agent's own token. See [Installation](Installation.md). |
| `MAX_MISSION_BYTES` | No | `209715200` (200 MB) | Largest `.miz` upload accepted. |
| `COOKIE_SECURE` | No | `true` | Set to `false` only for local HTTP-only development. Production needs real HTTPS in front, or login loops back to the login page forever. |
| `WEBGUI_CONTROL_PORT` | No | `8088` | Must match the reverse proxy's second server block. See [Installation](Installation.md). |
| `BRAND_NAME` | No | `DCS Auth Gate` | Shown in the navbar. |
| `AUTH_GATE_STATE_DIR` | Production only | none | Required for A/B self-update. Derives `webgui-static/`, `active-slot`, `auth-gate.log`, and `auth-gate.sqlite` as fixed sub-paths of this one directory. See [A/B Self-Update](A-B-Self-Update.md). |

### Deprecated, still work

Each still overrides its one path individually, taking priority over `AUTH_GATE_STATE_DIR`. Kept only for existing deployments; new ones should set `AUTH_GATE_STATE_DIR` instead.

| Variable | Default | Replaced by |
|---|---|---|
| `SQLITE_PATH` | `./local-only/data/auth-gate.sqlite` | `<AUTH_GATE_STATE_DIR>/auth-gate.sqlite` |
| `WEBGUI_STATIC_PATH` | repo-relative `webgui-static/` | `<AUTH_GATE_STATE_DIR>/webgui-static` |
| `ACTIVE_SLOT_PATH` | repo-relative `active-slot` | `<AUTH_GATE_STATE_DIR>/active-slot` |
| `AUTH_GATE_LOG_PATH` | repo-relative `auth-gate.log` | `<AUTH_GATE_STATE_DIR>/auth-gate.log` |

## mission-agent (`src/agent.js`)

Runs on a different machine. Never reads the auth-gate's `.env`.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `AGENT_PORT` | No | `4000` | |
| `MISSION_AGENT_TOKEN` | No | generated on first start | Must match the auth-gate's own token. See [Installation](Installation.md). |
| `MISSION_AGENT_TOKEN_FILE` | No | install directory | Where the generated token is saved and read from. Only needed to point it somewhere else. |
| `DCS_SAVED_GAMES_ROOT` | Yes in production | none | The real `Saved Games` folder on the physical host. |
| `MAX_MISSION_BYTES` | No | `209715200` (200 MB) | Largest `.miz` upload accepted. |
| `AGENT_LOG_FILE` | No | none (stdout only) | Where NSSM's own log capture is read from on `/admin/logs`. |

## Values that must match on both sides

See [Installation](Installation.md#values-that-must-match-on-both-sides).
