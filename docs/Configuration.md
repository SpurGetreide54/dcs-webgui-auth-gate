# Configuration

Both processes read their config from environment variables. The
auth-gate also reads `.env` in its own working directory. See
`.env.example` for a starting file.

## auth-gate (`src/server.js`)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | No | `3000` | |
| `SQLITE_PATH` | No | `./data/auth-gate.sqlite` | |
| `MISSION_AGENT_URL` | Yes | none | Base URL of the mission-agent. |
| `MISSION_AGENT_TOKEN` | Yes | none | Must match the mission-agent's own token. See [Installation](Installation.md). |
| `MAX_MISSION_BYTES` | No | `209715200` (200 MB) | Largest `.miz` upload accepted. |
| `COOKIE_SECURE` | No | `true` | Set to `false` only for local HTTP-only development. Production needs real HTTPS in front, or login loops back to the login page forever. |
| `WEBGUI_CONTROL_PORT` | No | `8088` | Must match the reverse proxy's second server block. See [Installation](Installation.md). |
| `WEBGUI_STATIC_PATH` | No | repo-relative `webgui-static/` | Set this explicitly in a production A/B deployment. See [A/B Self-Update](A-B-Self-Update.md). |
| `BRAND_NAME` | No | `DCS Auth Gate` | Shown in the navbar. |
| `ACTIVE_SLOT_PATH` | Production only | repo-relative `active-slot` | Required for A/B self-update. See [A/B Self-Update](A-B-Self-Update.md). |
| `AUTH_GATE_LOG_PATH` | Production only | repo-relative `auth-gate.log` | Required for A/B self-update. See [A/B Self-Update](A-B-Self-Update.md). |

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
