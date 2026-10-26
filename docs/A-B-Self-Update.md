# A/B self-update

## How it works

Both the auth-gate and the mission-agent can update themselves.

1. The auth-gate checks a signed GitHub release every hour.
2. A site admin triggers the actual update from `/admin/update`. The
   sidebar shows this page once a new version is found, or always, if
   pinned from `/admin/settings`.
3. The update stages the new version into whichever A/B slot is not
   currently running.
4. It relays and commits the mission-agent's own matching update.
5. It flips the active-slot pointer and exits.
6. The service supervisor restarts into the new slot.
7. A version that fails to start rolls back automatically.

A 60-second cooldown follows every trigger. It stops a double-click,
or a page reload, from starting a second update on top of one still
running.

See [Architecture](Architecture.md#ab-self-update) for why the
active-slot pointer is a flat file, not a database row. See
`src/updateCheck.js`'s own top comment for the full design, including
the Ed25519 signature check.

## Prerequisites

New deployments need this setup once, on each side, before
`/admin/update` works.

A fresh deployment is a plain single checkout. None of these exist
yet:

- two A/B slot directories on disk
- shared state (`webgui-static/`, the active-slot pointer, the log
  file) living outside either slot, so both slots read and write the
  same copy
- a second systemd unit, for rollback
- a stable `launcher.js` at the top level, outside both slots, for
  systemd to always point at

This is not automated. It touches root-owned systemd config and
restructures the app's own directory layout, so a human does it once,
deliberately. Routine updates after this need no further manual
steps.

### auth-gate side (on the VM)

1. Add these three lines to `.env`, if not already there:
   ```
   WEBGUI_STATIC_PATH=/var/www/dcs-webgui-auth-gate/webgui-static
   ACTIVE_SLOT_PATH=/var/www/dcs-webgui-auth-gate/active-slot
   AUTH_GATE_LOG_PATH=/var/www/dcs-webgui-auth-gate/auth-gate.log
   ```
   Each value must point outside either A/B slot's own directory. A
   value left at its slot-relative default breaks differently per
   variable. See [FAQ](FAQ.md) for `ACTIVE_SLOT_PATH` specifically.

   `AUTH_GATE_LOG_PATH` must also match the hardcoded `LOG_FILE` in
   `scripts/systemd/dcs-webgui-auth-gate-rollback.service` exactly.
   That unit runs as root, separately from the main service, and
   cannot read `.env`.

2. Create both slot directories. Seed slot A with the code already
   running, so the first real update has something to diff against:
   ```
   cd /var/www/dcs-webgui-auth-gate
   sudo mkdir -p releases/a releases/b
   sudo rsync -a --exclude releases --exclude local-only --exclude webgui-static --exclude node_modules . releases/a/
   sudo cp -r node_modules releases/a/
   sudo chown -R dcs-webgui-auth-gate:dcs-webgui-auth-gate releases
   echo -n a | sudo tee active-slot
   sudo chown dcs-webgui-auth-gate:dcs-webgui-auth-gate active-slot
   ```
   The last `chown` matters. See [FAQ](FAQ.md) for what happens if
   you skip it.

3. Copy `launcher.js` to the top level. It is not part of either
   slot. Install both unit files:
   ```
   sudo cp scripts/systemd/dcs-webgui-auth-gate.service scripts/systemd/dcs-webgui-auth-gate-rollback.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl restart dcs-webgui-auth-gate
   ```

4. Confirm it restarted through the new launcher:
   ```
   systemctl status dcs-webgui-auth-gate
   ```
   It should show active, and the app should still be reachable.
   `/admin/update` now handles every future update. This setup never
   needs repeating.

### mission-agent side (on the physical host)

Re-run `install.ps1` once:

```
.\install.ps1 -DcsSavedGamesRoot "C:\Users\dcsservice\Saved Games"
```

The updated script copies `agent.exe` into `releases\a\` and points a
`current` junction at it, instead of placing it directly in the
install directory. NSSM's own config targets `current\agent.exe`, a
path that never changes again across future updates. Safe to re-run
with the same parameters. See the script's own `.DESCRIPTION` for
exactly what changes.
