# Troubleshooting

Each entry states a symptom, then the fix.

## `/s/<slug>/` returns 503

`webgui-static/` is empty. Populate it. Copy a real DCS webgui bundle
in by hand, or run `/admin/servers/webgui-sync`. See
[Installation](Installation.md).

## The mission-agent rejects every request

`MISSION_AGENT_TOKEN` does not match on both sides. In production,
read `agent-token.txt` in the agent's install directory for the real
value. Compare it against the auth-gate's own env value. In local
development, check both env values directly.

## Need to rotate or recover the mission-agent token

Delete `agent-token.txt` in the agent's install directory. Restart
the service. It generates a fresh token on the next start. Or re-run
`install.ps1` with an explicit `-MissionAgentToken` to set a specific
value. Either way, update `MISSION_AGENT_TOKEN` on the auth-gate side
to match afterward.

## Login keeps looping back to the login page

`COOKIE_SECURE=true` needs real HTTPS in front of the auth-gate.
Without it, the browser never sends the session cookie back. Put a
working reverse proxy in front, or set `COOKIE_SECURE=false` for
local HTTP-only testing.

## Uploads, relay, or webgui-sync cannot find a server

`instance_name`, set in `/admin/servers`, must match the real DCS
instance folder name under `Saved Games` on the physical host,
exactly.

## The browser cannot reach the control-port proxy directly

`WEBGUI_CONTROL_PORT` must match the reverse proxy's second server
block. See [Installation](Installation.md). This is a separate
connection from the mission-agent one above. Check both
independently. A fix to one does not cover the other.

## `webgui-sync` 404s for a server

`webgui-sync` assumes a DCS install's WebGUI files sit directly under
`<install path>\WebGUI`.

## The update sidebar icon never appears, even after a real release

To reach `/admin/update` regardless, pin it visible from
`/admin/settings` instead of debugging this.

Otherwise, check `update_state.last_checked_at` in the SQLite
database. `NULL` means the hourly check has not run, or keeps
failing. A failure is logged, not thrown. Check the service's own
log or journal for `Update check failed: ...`. Common causes: the
GitHub release has no `signed_updates.json` asset, or it failed
Ed25519 verification.

## Clicking "Update now" a second time shows a cooldown message

"Try again after HH:MM:SS UTC" is the 60-second cooldown working as
designed, not a bug. It stops a double-click, or a page reload, from
starting a second update on top of one still running. Wait for the
window to pass, or check `update_state.update_triggered_at` in the
database for when it last fired. See [A/B Self-Update](A-B-Self-Update.md).

## Clicking "Update now" does nothing visible, or the service never comes back

The update runs in the background, after the page responds. It ends
in a deliberate process exit on success. `systemctl status
dcs-webgui-auth-gate` and its journal are the real source of truth,
not the browser.

If the new slot fails to start, the rollback unit should fire. Check:
```
journalctl -u dcs-webgui-auth-gate-rollback
```
It should **not** fire after an update that completed and restarted
cleanly. If it does, the exit-on-success fix is not live yet. See
[FAQ](FAQ.md). See [A/B Self-Update](A-B-Self-Update.md) if the
rollback unit was never installed.
