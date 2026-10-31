# FAQ

Each entry answers a design question, not a symptom. For a symptom,
see [Troubleshooting](Troubleshooting.md) instead.

## Why does this project exist at all?

A DCS control port accepts connections only from 127.0.0.1, its own
machine.<br>A direct reverse proxy to it does not work.<br>This project
tried that and dropped it.<br>See [Architecture](Architecture.md).

## Why does the real DCS webgui's own traffic get rewritten?

A cross-port `fetch()` call does not carry cookies, even on the same
host.<br>The app swaps in a short-lived control token instead.<br>See
[Architecture](Architecture.md).

## Why can't a fix shipped in a release protect its own install?

The **old** process runs `applyUpdate()`, not the new one.<br>The new
code only takes effect starting with the update after the one that
ships it.<br>A fix to the update logic itself needs one extra update
cycle before it is live.

## Why doesn't "delete" on a mission actually delete the file?

It moves the file to a `.trash/` folder inside the mission folder.<br>It never unlinks it. The missions page's own Trash section can move it
back out, but nothing in the app ever empties `.trash/` permanently —
that's done by hand on the host, outside this app.

## Why can't a `<form>` wrap a table row?

A browser silently drops or relocates a `<form>` nested directly
inside a `<tr>`, during HTML parsing.<br>Inputs that look like they are
"inside" it never actually submit with it.<br>This caught a real bug:
per-server checkboxes on the accounts page silently reset on every
save.

## Why is the active-slot pointer a flat file, not a database row?

`launcher.js`, the small bootstrap that starts the right A/B slot,
depends on nothing beyond Node itself.<br>A database dependency there
would break that rule.<br>See [Architecture](Architecture.md).

## Why does a Windows Firewall rule need two copies, one per slot?

`current` is a directory junction, a symlink-style path.<br>Windows
Firewall does not match a program-path rule against a symlink path.<br>Confirmed in practice. Each A/B slot needs its own rule, pointed at
its real resolved path.<br>See
[Installation](Installation.md#windows-firewall).

## Why does A/B setup need a `chown` on `active-slot`?

`sudo tee active-slot` creates the file as root.<br>The service account
that flips it during a real update is unprivileged, not root.<br>Skip
the `chown`, and an update stages successfully, relays the agent
update, and then fails silently at the very last step with a
permission error.<br>The idle slot ends up fully built, the agent
already flipped, and the auth-gate itself stuck on the old version.

## Why do static assets have a day-long cache lifetime?

Without it, every page load sends a fresh request for every sidebar
icon, which showed up as a visible flash before the real icons
painted in.<br>The cost: an edited file needs a hard refresh in
development, or up to a day in production, to show up anywhere a
browser already cached it.
