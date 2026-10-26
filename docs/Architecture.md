# Architecture

## Two processes

**`src/server.js`**, the auth-gate.<br>Runs on the control-panel VM.
Serves the login pages, the admin pages, and the real DCS webgui as a
static bundle.<br>Also runs a second listener in the same process: the
control-port proxy.<br>See [Deployment Topology](Deployment-Topology.md)
for where this VM actually sits.

**`src/agent.js`**, the mission-agent.<br>Runs on the physical host next
to the DCS gameservers. It is the only process that can reach a
control port directly.<br>It handles mission uploads, mission listing
and download, `autoexec.cfg` reads and writes, and relays control-port
traffic from the auth-gate. It has no accounts and no login.<br>A shared
token authenticates every request to it.

## Why the control port needs a gate

A DCS control port accepts connections only from 127.0.0.1, its own
machine.<br>A plain reverse proxy from the internet to that port does not
work. This was tried and dropped (see `src/db.js`'s comment on the
removed `upstream_url` column).<br>The auth-gate exists to solve this a
different way: the mission-agent sits on the same machine as the
control port and relays traffic for it, over an internal connection
the auth-gate reaches.

## The fetch-rewrite bootstrap

The real DCS webgui is a static single-page app, shipped with no
server of its own.<br>Its own JavaScript tries to reach a backend at
whatever host and port it decides on. That logic is undocumented, and
not guaranteed to match the page's own address.

The auth-gate does not try to guess that logic.<br>Instead, it rewrites
the page at the network layer: any `fetch()` call that is not for one
of the app's own static files gets redirected to the one shared
control-port proxy.

A plain cookie cannot authorize this redirect.<br>Cross-port `fetch()`
calls do not carry cookies by default, even on the same host.<br>The
auth-gate uses a control token instead:

1. An admin loads `/s/<slug>/`.
2. The auth-gate mints a short-lived token for that admin and that
   server (`src/controlTokens.js`).
3. The page's own `fetch()` calls carry this token as a header.
4. The control-port proxy (`src/serverProxy.js`) checks the token on
   every request, and resolves it to a real admin and a real server.<br>It never trusts anything else the client sends.

A token's expiry slides forward on every use, not a one-shot timer.<br>The real DCS webgui polls its own backend every few seconds on its
own. An admin who leaves a server's panel open keeps the session
alive.<br>A hard ceiling still applies, so a leaked or forgotten token
cannot stay useful forever.

## A/B self-update

Two full copies of the auth-gate's code live on disk at once,
`releases/a/` and `releases/b/`.<br>One is active. A self-update stages
the new version into the idle slot, then flips a pointer to it.

The active-slot pointer lives in a plain file, not the database.<br>`launcher.js`, the small bootstrap that reads this pointer and starts
the right slot, depends on nothing beyond Node itself.<br>Giving it a
database dependency would break that rule.<br>See
[A/B Self-Update](A-B-Self-Update.md) for the full update flow.

## State split: database vs flat files

Most state (accounts, servers, access grants, sessions, settings)
lives in one SQLite database, shared by both A/B slots.<br>A few values
must survive an update that swaps the running code out from under
itself, so they live outside the database too:

- the active-slot pointer (`active-slot`, a flat file)
- the shared log file path
- the shared `webgui-static/` path

Each of these lives at the top level, outside either slot's own
directory, set once in `.env`.<br>See [Configuration](Configuration.md).
