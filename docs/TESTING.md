# Testing and troubleshooting

## Running tests

```
npm test
```

This runs `node --test` against `test/`. Real DCS servers and the real
mission-agent are not involved. Dummy in-process HTTP servers stand in for
the mission-agent instead.

This verifies the auth-gate's own logic: login, access checks, uploads,
proxying, and the admin pages. It does not verify:

- a real DCS server
- a real Windows host running `agent.exe`
- a real reverse-proxy hop

Those need a real deployment to check. See [SETUP.md](SETUP.md).

## Troubleshooting

**`/s/<slug>/` returns 503.**
`webgui-static/` is empty. Populate it — copy a real DCS webgui bundle in
by hand, or run `/admin/servers/webgui-sync`. See SETUP.md.

**The mission-agent rejects every request.**
`MISSION_AGENT_TOKEN` must match exactly on both the auth-gate and the
mission-agent. In production, the agent generated its own — read
`agent-token.txt` in its install directory to see the value it's actually
using, then compare it against the auth-gate's env. In local development,
check both env values instead — you set this one yourself there.

**Need to rotate or recover the mission-agent token.**
Delete `agent-token.txt` in the agent's install directory and restart the
service — it generates a fresh one on the next start. Or re-run
`install.ps1` with an explicit `-MissionAgentToken` to pin a specific
value. Either way, update `MISSION_AGENT_TOKEN` on the auth-gate side to
match afterward, or every request will fail again.

**Login keeps looping back to the login page.**
`COOKIE_SECURE=true` needs real HTTPS in front of the auth-gate. Without
it, the browser never sends the session cookie back. Either put a working
reverse proxy in front, or set `COOKIE_SECURE=false` for local
http-only testing.

**Uploads, relay, or webgui-sync can't find a server.**
`instance_name` (set in `/admin/servers`) must match the real DCS instance
folder name under `Saved Games` on the physical host, exactly.

**The browser can't reach the control-port proxy directly.**
`WEBGUI_CONTROL_PORT` must match the reverse proxy's second server block.
See SETUP.md's auth-gate deployment notes. This is a browser-to-VM
connection, separate from the VM-to-agent connection above ("The
mission-agent rejects every request") — check both independently rather
than assuming a fix to one covers the other.

**`webgui-sync` 404s for a server.**
`webgui-sync` assumes a DCS install's WebGUI files sit directly under
`<install path>\WebGUI`.

**The update sidebar icon never appears, even after a real release.**
Check `update_state.last_checked_at` in the SQLite DB -- `NULL` means the
hourly check hasn't run or keeps failing. Failures are logged (not
thrown), so check the service's own log/journal for `Update check
failed: ...`. Common causes: the GitHub release has no
`signed_updates.json` asset, or it failed Ed25519 verification (the
hardcoded `PUBLIC_KEY_PEM` in `src/updateCheck.js` doesn't match the key
`sign-updates.js` signed with).
