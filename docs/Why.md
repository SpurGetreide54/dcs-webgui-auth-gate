# Why

Each entry answers a coding-level question a comment pointed here from.
For why the app behaves a certain way to an operator running it, see
[FAQ](FAQ.md) instead.

## Why is the flash cookie a plain unsigned cookie?

It is not a session: the sessions table requires a logged-in
`admin_id`, but flash also has to work on pre-auth routes like
`/login` and `/setup`, where no admin is logged in yet.<br>It is
unsigned because everything it ever carries (a validation error, an
invite URL) is something the same browser's own user is about to see
again anyway, so there's nothing sensitive in that user tampering with
their own cookie before their own next page load.

## Why is the active slot pointer a flat file?

`launcher.js` reads it to decide which slot to launch, and
`launcher.js` has its own hard rule of zero dependencies beyond Node
itself, across every update, forever.<br>A database row would need
`better-sqlite3`, a native module, which breaks that rule.<br>A flat
file needs nothing but `fs`. See [db.js](../src/db.js)'s `update_state`
table comment, which documents the same boundary from the database
side.

## Why do control-port requests use a separate token instead of the session cookie?

The real DCS webgui reaches its backend via `fetch()` to a swapped
hostname:port origin, not a path under the page that loaded it.<br>A
browser's default same-origin credentials mode never attaches the
session cookie to that request.<br>The token, minted server-side and
injected into that page's own `fetch()` calls (see `server.js`), is
the substitute.

## Why does a control token's expiry slide forward instead of using a fixed TTL?

The real DCS webgui polls its own backend every 2 seconds on its own
(see `webgui-static/js/app.js`'s `lifecycleTick`), so an admin who
just leaves a server's control panel open, the normal way to use this
app, keeps it alive indefinitely instead of losing control after a
flat 5 minutes with no visible error.<br>`MAX_TOKEN_LIFETIME_MS` still
bounds it, so a leaked or forgotten token can't stay useful forever
just because something keeps polling it.<br>Hitting that ceiling just
means the next page load mints a fresh one, same as any other page
load already does.<br>This doesn't weaken what the token protects
either way: `serverProxy.js` re-checks live database access on every
single proxied request, independent of token freshness.

## Why is there only one shared control port?

It matches the real DCS webgui's own default, so admins never learn a
different port per server.<br>Which real upstream a connection reaches
is resolved from the control-gate token (see `controlTokens.js`),
never from anything the client supplies directly, which is what stops
"just try a different port" from reaching a server without a grant
for it.

## Why doesn't the control-port proxy handle websocket upgrades?

The real DCS webgui doesn't use WebSockets at all (confirmed by
grepping the synced `webgui-static/js/app.js`, zero matches for
`WebSocket`/`socket`/`ws://`/`wss://`).<br>The old `ws: true` option
plus `httpServer.on("upgrade", proxyMiddleware.upgrade)` wiring, on
both the gate and the agent, let an unauthenticated raw upgrade
request reach `http-proxy-middleware`'s own `error` handler with a
bare `Socket` standing in for `res`, and that handler's
`res.writeHead(...)` call then threw, crashing the whole
process.<br>Since nothing needs upgrades, the fix removes the
capability instead of authenticating it: with no `upgrade` listener
registered at all, Node treats the request as an ordinary one and
routes it through the normal request path, same as any other request
to that URL.

## Why is it safe to reflect the request origin?

The control token rides in a custom header, so a cross-origin
`fetch()` sends a CORS preflight `OPTIONS` first.<br>Reflecting the
request's own origin (never a wildcard) is safe to pair with
`Access-Control-Allow-Credentials`, because authorization rides
entirely on the opaque token, not on any browser-ambient credential a
third-party origin could piggyback on.

## Why does the control-port proxy strip Cookie/Origin before relaying?

`http-proxy-middleware` forwards every incoming header except the
ones a `proxyReq` hook explicitly overwrites, so the browser's own
`X-Auth-Gate-Token`, session cookie, and origin all rode along
unchanged on both the gate-to-agent and agent-to-DCS hops by
default.<br>Both hops are server-to-server once past this app's own
checks, so none of those headers do anything useful on the other
end, and forwarding them widens what a compromised agent or DCS
process could see.<br>Each hop's `proxyReq` hook now calls
`removeHeader` on all three before the request leaves.

## Why does the log path default to a path under local-only?

Something created fresh on every run shouldn't need its own
`.gitignore` entry, the same reasoning as `db.js`'s own `SQLITE_PATH`
default.<br>That default only fits a plain single-checkout local dev
setup, so production overrides it with `AUTH_GATE_LOG_PATH` in `.env`,
set once during the A/B migration alongside `ACTIVE_SLOT_PATH` and
`WEBGUI_STATIC_PATH`.

## Why is each log line a single JSON object?

It's what makes a structured, chat-style rendering possible on
`/admin/logs` without scraping free text.<br>It's also resilient to a
multi-arg `console.log(a, b, c)` call, since all of its arguments are
joined into one message before anything's written.

## Why does every expiry use SQLite's own datetime() instead of JS Date?

Comparing a JS ISO string (`...T...Z`) against SQLite's own
`datetime('now')` format (`YYYY-MM-DD HH:MM:SS`) is a plain string
comparison, and the two formats sort inconsistently at the same
instant.<br>That looks fine for a 12 hour session expiry, since the
date part alone usually differs, but it silently breaks the 15 minute
rate-limit window, where same-day comparisons depend on the mismatched
`T`/space byte.<br>Keeping every timestamp in SQLite's own format
sidesteps the mismatch entirely.

## Why is verifyPassword async but hashPassword isn't?

A bcrypt compare at this app's cost factor takes around 260ms, measured
directly with the project's own `bcryptjs` dependency.<br>Run
synchronously, that blocks the whole event loop solid for 260ms on
every login attempt, including the 2-second control-panel polling
every open server panel relies on.<br>`bcryptjs`'s own async `compare`
yields the event loop between internal rounds instead, so `/login` and
`/change-password`'s current-password check both call it with
`await`.<br>`hashPassword` stays synchronous: every call site
(`/setup`, invite-accept, a new password on `/change-password`,
account creation) is a rare, admin-triggered write, not part of the
threat model the event-loop stall is about, and converting it too
would force two more handlers to become `async` for no benefit.

The same `await auth.verifyPassword(...)` call in `/login` also closes
a timing side channel: skipping the compare entirely for an unknown
username let it return in a couple of milliseconds, while a known
username paid the full ~260ms, letting anyone enumerate valid
usernames by timing alone (measured directly: known-username median
264ms vs. unknown-username median 2.3ms).<br>`DUMMY_PASSWORD_HASH`, a
hash of no real password computed once at module load, is compared
via that same call whenever the submitted username doesn't match a
real admin, so both paths always pay for one real bcrypt compare.

## Why does requireAuth check Sec-Fetch-Dest?

`Sec-Fetch-Dest` is set by the browser itself, `app.js` can't override
it, so it reliably tells apart a real page load from the SPA's own
`fetch()` calls, both of which hit `/s/<slug>/...` paths.<br>A missing
header (curl, very old browsers) defaults to `"document"`, so a human
hitting the URL directly sees the login page, not raw JSON.

## Why does getAccessibleServers select server_id explicitly?

`servers.*` alone gives a bare `id`, the server's own id, with no way
to tell it apart from an `admin_server_access` row's id.<br>A caller
checking "does this admin have access to server X" via `.server_id`
would get `undefined` and never match.<br>Left unfixed, the accounts
page rendered every checkbox as unchecked, regardless of the real
grant.

## Why are there two ways to set an admin's permissions?

`setAccess` replaces a row's whole permission set at once, used only
where every flag is decided together (initial grant at account/invite
creation, the bootstrap site admin); any flag left out of `grants` is
explicitly cleared, not left alone.<br>`setPermission` toggles exactly
one cell instead, for the matrix popup's per-cell click, and never
touches the other columns.<br>`invites.js`'s `setInvitePermission`
mirrors `setPermission` for the same popup on a pending invite.

## Why does the permission migration backfill from can_upload_missions?

Adding the `can_view_missions`/`can_download_missions`/`can_delete_missions`
columns is harmless on its own, they default to 0, but a database that
already had upload-granted admins would otherwise lock every one of
them out of the now-view-gated `/missions` page the moment this
ships.<br>The one-time backfill right after adding the columns carries
their existing access forward.<br>It only runs in the same pass the
columns are first added, so a later toggle of upload alone never
re-grants view.

## Why does update_state track when an update was last triggered?

`update_state` didn't originally track this.<br>It's needed for the
cooldown guard against double-triggering `applyUpdate()`, confirmed in
production: a double-click once fired two full update cycles 24
seconds apart.

## Why is signed_updates.json the trust root instead of GitHub itself?

It's attached as a release asset on GitHub, signed with an Ed25519
private key kept off this repo entirely (gitignored, never
committed, see `scripts/release/sign-updates.js`).<br>Only the
public key ships with the app.<br>A compromised GitHub account or a
MITM'd download can serve bytes, but can't produce a manifest this
code will accept without that private key.

## Why does sign-updates.js not require updateCheck.js?

`updateCheck.js` requires `./db`, which opens and migrates the SQLite
file and loads the native `better-sqlite3` module as a side
effect.<br>`sign-updates.js` runs on the releaser's own machine, not a
deployed instance, and only ever needed one constant,
`GITHUB_REPO`.<br>Requiring `updateCheck.js` just for that left a
stray database file behind on every release run, and failed outright
if the native module wasn't built there.<br>`updateConstants.js`
holds `GITHUB_REPO` with no further requires of its own, so
`sign-updates.js` can read it without booting anything.

## Why is fetchVerifiedManifest always re-fetched instead of cached?

Callers never see an unsigned or tampered manifest this way.<br>It's
re-fetched fresh every time `checkForUpdate` and `applyUpdate` both
call it, never trusted from a cache.<br>The database's own cached
fields exist for display only, never as something to act on.

## Why does checkForUpdate re-throw its own errors?

`checkForUpdate` only ever updates `update_state` for display, never
stages or applies anything, that's `applyUpdate()`'s own job, run
explicitly by a site admin.<br>A failure still records that a check
was attempted, but is re-thrown rather than swallowed: an admin who
just clicked "check now" needs to know the check itself failed, not
see a false "you're up to date."<br>`startHourlyCheck()`'s own silent
background-poll behavior comes from catching it there instead.

## Why does checkForUpdate reject a lower or equal version?

The signature on `signed_updates.json` proves the release was signed
with the real key, not that it's the newest one.<br>Any older,
validly-signed manifest could still be offered as GitHub's "latest"
(a compromised GitHub account replacing the release asset, or a stale
cache), and this app would install it as a downgrade, rolling every
site back to a build with a known bug.<br>`isVersionGreater` parses
each version's `X.Y.Z` numeric triple (ignoring any `-alpha`-style
suffix, no `semver` dependency needed) and only treats a strictly
greater manifest version as an update.<br>No deliberate-rollback path
exists through this channel: the automatic, local,
crash-triggered rollback unit already covers a bad release's real
failure mode without touching GitHub at all.

## Why is the agent relay timeout only 60 seconds?

Without it, a stalled upload to a real remote host can hang
indefinitely with no error at all, the in-flight `applyUpdate()` call
just sits there forever.<br>Kept short deliberately: the auth-gate and
mission-agent only ever talk over the internal network between the
control-panel VM and the DCS host (see
[Deployment Topology](Deployment-Topology.md)), never the open
internet, so even the agent's ~96MB build should move in single-digit
seconds.<br>Anything still running after a minute already means
something's broken, not just slow, and failing fast beats an admin
waiting minutes to find that out.

## Why does the auth-gate relay the agent's update?

The agent has no internet access of its own by design, kept off the
host's internet-facing side (see
[Deployment Topology](Deployment-Topology.md)).<br>The auth-gate is
the one that reaches GitHub, so it hands the bytes onward over the
existing internal auth-gate to agent channel instead.

## Why does applyUpdate() exit(0) instead of exit(1)?

Confirmed the hard way in production: `exit(1)` made this deliberate,
successful handoff look like a failure to systemd, which fired
`OnFailure=` (the rollback unit) on literally every successful update,
undoing it before the new slot ever got a real chance.<br>`OnFailure=`
fires on *every* failed exit, not only once `Restart=` has exhausted
`StartLimitBurst` and given up, so the unit's own `Restart=always`
(not `on-failure`, which only restarts on a failing exit) is what
still brings the new slot up after a clean `exit(0)`.<br>A genuine
crash is still a non-zero/signal exit, so real bad-update detection
via `OnFailure=` is unaffected.

## Why does the mission agent have no accounts, just a shared bearer token?

The agent is small and deliberately short of real delete access: a
mission-upload endpoint, a list/download pair, a soft-delete-to-trash
(moves a file aside, never unlinks it), a webgui control-port relay,
and a shared-token check.<br>No accounts and no login means the
shared bearer token can't tell admins apart, so nothing here can
destroy a mission file outright.<br>A leaked token can add files and
move files into `Missions/.trash/`, never erase one for good.

## Why does safeMissionPath reject empty and dot-led names?

`.` and `""` both resolve to `targetDir` itself once joined and
resolved, and the old path check had a special case
(`resolvedFinal !== resolvedTarget && ...`) that let exactly that
through as "safe."<br>Confirmed by reproducing the crash: downloading
a mission named `.` passed that check, then
`fsSync.createReadStream(dir)` emitted an uncaught `EISDIR` with no
error listener, killing the agent process and every server's control
channel with it until NSSM restarted it.<br>Rejecting any name that is
empty or starts with `.` removes the one case the special-case check
existed for, so the check could be simplified back to a plain
`startsWith(resolvedTarget + path.sep)`.<br>The same gap let the trash
route rename the Missions directory into itself (`EINVAL`) after
already moving earlier names in the same request, which is why every
name in a trash request is still validated before any file is moved.

## Why does agent.js duplicate appLog.js's log format instead of importing it?

This file builds standalone into `agent.exe` with zero dependency on
`src/`, the same isolation `resolveAgentToken()` relies on.<br>Only
what gets printed changes here, NSSM's own `AppStdout`/`AppStderr`
redirection (`install.ps1`) still does the actual writing and
rotation, unchanged.

## Why does the agent persist its own generated token instead of requiring one upfront?

An explicit `MISSION_AGENT_TOKEN` env value always wins, but
otherwise this agent is the source of truth: it generates one on
first start and persists it next to itself, so a deployer never has
to invent a value by hand for a headless service with no interactive
prompt.<br>The value itself is never logged, only which of these two
cases happened, since `agent.log` is easy to end up pasted into a
chat or a screen share.

## Why does Content-Disposition carry two filenames?

RFC 6266 clients don't decode percent-escapes in the plain `filename`
parameter, so a mission named `My Mission.miz` sent as
`filename="My%20Mission.miz"` could save under that literal encoded
name instead of the real one.<br>`filename*=UTF-8''<encoded>` is the
form browsers actually decode, but a client that doesn't understand
it falls back to `filename=`, so both are sent: a quoted ASCII
fallback (non-ASCII bytes replaced, `"`/`\` backslash-escaped per
quoted-string syntax) for the clients that ignore `filename*`, and
the real UTF-8 name in `filename*` for the ones that don't.

## Why isn't the DCS install path confined to a fixed root?

Unlike `instanceName`, which is confined under `SAVED_GAMES_ROOT`,
the install path for pulling a webgui bundle is arbitrary admin-typed
input with no fixed root to confine it to.<br>This is the same trust
level an account-manager admin already has via `instance_name` and
mission uploads, not a new privilege boundary.

## Why does readWebguiPort anchor its regex per line?

The original `/webgui_port\W*=\W*(\d+)/i` had no line anchor and let
`\W*` span newlines, so a commented-out example line (`-- webgui_port
= 8088`, a real pattern DCS itself writes into a fresh
`autoexec.cfg`) or an unrelated key like `my_webgui_port` would match
and silently report the wrong port.<br>Anchoring per line
(`^\s*webgui_port\s*=\s*(\d+)\s*(?:--.*)?$`, with `m` so `^`/`$` match
line boundaries) fixes both, while still tolerating a trailing Lua
comment on the real line.<br>Taking the last match when several exist
mirrors how Lua itself would evaluate repeated assignments in the
same file.

## Why does the agent use a "current" junction instead of NSSM's own config?

`"current"` is a directory junction NSSM's `ExecStart` always targets
(`...\current\agent.exe`).<br>Flipping the junction, not NSSM's own
config, is what switches versions between restarts.<br>The restart
itself is deliberate, not a crash, same reasoning as the auth-gate's
own exit-based flip: no `sc.exe`/NSSM call is needed, the Windows
service's own restart-on-exit policy brings the process back up
through the now-repointed junction.

## Why does the commit handler build the junction under a temp name first?

`fs.symlink` can fail partway through (permission, a locked directory,
antivirus), and the old approach removed `current` before recreating
it, so a failure there left no junction at all and the next NSSM
restart couldn't find `agent.exe`.<br>Building `current.new` first and
only then swapping it in means a failure during the build step leaves
the original `current` completely untouched, and a failure during the
swap step leaves a known-good junction sitting at `current.new` for
manual recovery (rename it to `current`, restart), logged with that
exact path so it's easy to find.

## Why does views.js read the DB for the update icon?

Every other piece of page data is loaded by `server.js` and passed
in, but the update-available sidebar icon has to show on every
authenticated page.<br>Threading one more parameter through every
single page function's call site for a single cheap synchronous read
isn't worth it, and `updateCheck.js`'s own DB read is a single-row
`SELECT`, not network I/O, so this stays fast.

## Why are icons inlined instead of referenced via <img src>?

An `<img>` is a separate network and decode step after the HTML
itself has already painted, which showed up as a visible placeholder
flash on every navigation.<br>This app has no client-side JS to hide
the page behind a "wait until images are loaded" gate, by deliberate
house style, so inlining sidesteps the problem instead of needing
one.

## Why does the permissions matrix use a shared popup?

It replaces inline per-server checkboxes, which got unreadable once
server access, upload, view, download, and delete were five separate
per-server toggles at once instead of two.<br>One popup, filled in by
whichever row's button was last clicked, scales to any number of
permission categories without the table itself growing columns.

## Why does each table row get its own out-of-band form?

A `<form>` can't legally wrap a `<tr>`/`<td>`.<br>Browsers silently
relocate or drop it during HTML parsing, so checkboxes "inside" it
never actually belong to it and don't get submitted.<br>The fix: one
empty `<form id="...">` per row, placed outside the table, with every
input/button in that row linked to it via `form="..."` instead of
nesting. It must carry `class="row-form"` (`style.css`) or the plain
`form { ... }` rule renders it as a visible blank box;
`test/auth-gate.test.js`'s `assertNoBrokenTableForms()` checks both
of these automatically on any page that uses the pattern.

## Why does the logs page merge both sources into one timeline?

One merged, chat-style timeline, oldest at top and newest at bottom
like a real chat transcript, reads easier than two separate
auth-gate/agent blocks.<br>`#latest`, an empty anchor right after the
newest entry, is what every link to this page points at, so landing
here always lands scrolled to the newest entries without any
client-side script, which this app has none of anywhere else.

## Why does the app trust exactly one proxy hop?

nginx's `$proxy_add_x_forwarded_for` appends to `X-Forwarded-For`
rather than replacing it.<br>Trusting the full chain would let a
client spoof `req.ip` with their own header and dodge the login rate
limiter, so only the one real hop (nginx itself) is trusted.

## Why do static assets get a 1-day cache lifetime?

Without it, every page load or reload sends a fresh conditional
request for every sidebar icon before the browser is allowed to reuse
what it already has, which showed up as a visible placeholder flash
on each reload.<br>These are small, rarely-changed icons with no
content-hashed filename to cache-bust on, so a day is long enough to
kill the flash and short enough that an icon swap still shows up again
without a hard refresh.

## Why does changing your password sign out every other session?

This is self-service, available to every admin, not just site admins,
which is why it isn't gated by `requireAccountManager`.<br>Requiring
the current password first, then signing out every other session, is
what lets the real account owner kick out anyone (or anything
hijacked) still logged in elsewhere.

## Why is webgui-static/ synced explicitly rather than automatically?

This is an explicit admin action, the same shape as the webgui-ports
confirm flow: a silent DCS update on the host must not silently change
what every admin sees.<br>`webgui-static/` stays one shared folder for
every server slug, the admin just picks which configured server to
sync *from*.

## Why must the webgui-sync scratch directory be a sibling of webguiRoot?

`rename()` across filesystems fails with `EXDEV`, and
`WEBGUI_STATIC_PATH` can point anywhere, so nothing guarantees a
scratch directory placed elsewhere (e.g. under `local-only/`) would
share a filesystem with it.<br>A sibling directory is guaranteed to,
which is what makes the fast, atomic swap-via-rename actually safe.

## Why is webgui-static/ gitignored instead of shipped?

The real DCS webgui is shared-source, not open source, so
redistributing it isn't allowed.<br>Each deployment populates this
directory itself, from its own legitimate copy.<br>Its absence is an
expected state on a fresh checkout, not a bug, and login/accounts/
servers admin all still work before it's in place.

## Why does the bootstrap injection match the script tag with a regex?

A real DCS webgui build ships this minified, with no quotes around the
`src` attribute (`<script src=js/app.js></script>`), which an exact
literal-string match misses silently.<br>A silent miss means the
bootstrap never gets injected: `app.js` runs with native `fetch()`,
talks straight to `127.0.0.1` instead of the control-port proxy, and
every admin just sees "server not responding" with no error anywhere.

## Why does the auth-gate rewrite fetch() instead of a plain reverse proxy?

The real DCS webgui is a static SPA with no server of its own.<br>Its
own connection logic tries to reach a backend at whatever host/port it
decides on, undocumented and not necessarily the page's own
hostname:port, so this rewrites it at the network layer instead of
guessing that logic.<br>Cross-port `fetch()` doesn't carry cookies by
default even though the cookie is host-scoped, so a plain reverse
proxy would have nothing to authorize the connection with, which is
why a short-lived per-load token (see `controlTokens.js`) is attached
instead.

## Why does the backend-url rewrite undo a literal backslash?

The real DCS webgui's own default backend URL is malformed,
`http://127.0.0.1\:8088/...` with a literal backslash before the port
colon.<br>Per the URL spec, a backslash right after the host ends
authority parsing for http(s) URLs, so the port number falls into the
path instead and rides along untouched, showing up doubled next to the
port this code sets correctly, unless that one escape is undone
first.<br>The quadruple/double backslashes in the actual regex (not a
plain single/double) are themselves needed because this block is a JS
template literal inside `server.js`: confirmed with `node -e` that a
plainer count gets silently mis-escaped by Node's own parser before it
ever reaches the browser.

## Why does the bootstrap fake the control-port discovery call?

The real DCS webgui's own discovery call (`ACTION=GetJSONData`) only
exists to hand back `{ address, webPort, webKey }` so the app can set
its live backend URL and derive its AES key from `webKey`.<br>The
app's own code already skips this call entirely when opened via
`file://` or localhost, hardcoding this exact response instead,
because `webKey` is a fixed, publicly known constant baked into every
DCS install, never a per-server secret.<br>Mirroring that same
shortcut here, for the reverse-proxied case, is exactly as legitimate
as the app's own file://+localhost path already is.

## Why is the back button anchored to the navbar brand?

The real DCS webgui has no link back to the auth-gate dashboard, so
the only way out is otherwise the browser's own back button, unreliable
since the webgui's Vue router does its own in-page navigation.<br>The
button is anchored next to the "DCS Server" title rather than a fixed
screen corner because the left icon sidebar can collapse or expand and
would shift or cover a corner-anchored button, while the top bar
itself never moves.

## Why does shutdown call db.close() explicitly?

Leaving `better-sqlite3`'s native handles to garbage collection or
finalizers has crashed the process during teardown instead of exiting
cleanly, so shutdown closes the database explicitly before exiting.

## Why does launcher.js never update itself?

It's deliberately tiny: read which slot is active, run that slot's
real `server.js`, no business logic and no npm dependencies, nothing
an update should ever need to touch.<br>It intentionally doesn't share
code with `src/activeSlot.js`, which the rest of the app uses for the
same read, to keep its own dependency surface at exactly zero beyond
Node itself.<br>It sits at the top level, a sibling of `releases/a/`
and `releases/b/`, so systemd's `ExecStart` targets it directly and
never needs to change across updates. Changing it is a manual,
deliberate step (edit it over SSH, restart the service by hand).

## Why is the node.exe zip's sha256 checked into the script instead of fetched fresh?

It's pinned against nodejs.org's own `SHASUMS256.txt` for this
specific release, checked into this repo's own git history rather
than trusted fresh from a re-downloaded checksums file on every
build.<br>A compromised or altered download has to fake a value that
already lives in this repo's history, not just whatever nodejs.org
happens to serve today.

## Why does sign-updates.js care about key order?

This exact object, stringified, is what gets signed.<br>`verifyManifest()`
in `src/updateCheck.js` re-stringifies the same keys (everything except
`signature`) in the order they were parsed from the file, so writing
`{...signed, signature}` here keeps that order intact end to end;
reordering the fields would make a genuinely valid manifest fail
verification.

## Why is the rollback a separate systemd unit?

It runs whenever `dcs-webgui-auth-gate.service`'s `OnFailure=` fires,
which (after the exit(0)/`Restart=always` fix, see "Why does
applyUpdate() exit(0) instead of exit(1)?") now only happens for a
genuine failed exit, not a successful update's deliberate
handoff.<br>This is deliberately a *separate* unit, not logic inside
the app, because the `dcs-webgui-auth-gate` service account has no
sudo (confirmed during the A/B design's own live-infra audit), so it
cannot call `systemctl` itself.<br>Flipping `active-slot` back and
restarting is correct precisely because a failed start always just
happened in whichever slot an update flipped *to*, so "the other
slot" is always the last one that was actually working.

## Why does the rollback unit hardcode its own paths?

`LOG_FILE` must match whatever `AUTH_GATE_LOG_PATH` is set to in the
shared `.env`, but this is a separate root-run unit with no
`EnvironmentFile` of its own, so it can't read that value and has its
own hardcoded copy instead, same as `STATE_FILE` already is.<br>A
rollback is exactly the kind of event `/admin/logs` exists to surface,
so it's worth logging here too, not just via `systemctl`'s own
journal.

## Why does the rollback unit call reset-failed before start?

The real unit's `OnFailure=` only fires after it has already hit its
own `StartLimitBurst`/`StartLimitIntervalSec`, so by the time the
rollback unit runs, `dcs-webgui-auth-gate` is in systemd's rate-limited
"failed" state.<br>A plain `systemctl start` on a rate-limited unit is
refused ("Start request repeated too quickly") until
`systemctl reset-failed` clears it or the interval passes, which would
leave the service down right when the rollback is supposed to bring it
back.<br>Confirmed with a throwaway `systemd --user` unit: the refusal
and the `reset-failed` fix both reproduce exactly as described.

## Why is every %s doubled in this ExecStart?

Systemd expands a bare `%` as its own unit-file specifier syntax
*before* the shell ever sees the line (a bare `%s` alone means "the
invoking user's default shell"), not just inside the shell's own
`printf`.<br>Confirmed the hard way in production: a bare `%s` here
silently turned `printf %s "$NEW"` into `printf /usr/bin/bash
"$NEW"`, writing the literal text `/usr/bin/bash` into `active-slot`
instead of `"a"`/`"b"`, corrupting the one thing this unit exists to
fix, the first time it ever actually fired.<br>`%%` is the escape for
a literal `%` in any `ExecStart=` line, same as it would be for `%i`,
`%n`, or any other specifier.

## Why does install.ps1 only ever point the junction at slot a?

The junction is what makes the A/B self-update system work on the
agent's side (see `src/agent.js`'s "self-update: stage + commit"
section): NSSM always points at `current\agent.exe`, a path that
never changes, while an update flips the junction between
`releases\a\` and `releases\b\` and restarts.<br>This script only
ever (re)creates the junction pointing at `releases\a\`, it never
touches `releases\b\` or an update already staged there.<br>Re-running
it always resets the junction back to `releases\a\`, discarding any
staged-but-not-yet-active update in `releases\b\`: fine for a config
change, but worth knowing before re-running this right after an
update was staged.

## Why does install.ps1 stop the service twice?

On a host that's already installed and running, `releases\a` holds
the currently-executing `agent.exe` (`current\` points there by
default), and Windows refuses to overwrite a locked, running
executable.<br>Stopping it before the copy, not just before
re-registering further down, is what actually makes re-running this
script safe.<br>The full stop-and-remove-via-NSSM teardown still runs
again later, right before re-registering the service.

## Why are both NSSM checksums pinned instead of fetched fresh?

Both were verified once against the real nssm.cc download and pinned
here, not trusted fresh on every install run.<br>`NssmExeSha256`
covers the bare win64 binary the release zip vendors at
`NssmSourcePath`, reusing a copy already fetched and verified once
rather than hitting nssm.cc (a small, flaky site that has 503'd on
us) again on every single install.<br>`NssmSha256` covers the nssm.cc
zip this falls back to downloading only when that vendored copy is
missing or stale.

## Why are token and log paths pinned to InstallDir?

`agent.js`'s own default for `MISSION_AGENT_TOKEN_FILE` (next to
`process.execPath`) would otherwise resolve to
`current\agent-token.txt`, which the `current` junction makes
slot-local (`releases\a\agent-token.txt` today).<br>An update flipping
to `releases\b\` would then look like the token got reset, when really
the file just got left behind in the old slot.<br>Pinning it to the
stable top-level `InstallDir` keeps one token file shared across both
slots, the same way `.env` is shared on the auth-gate side.
`AGENT_LOG_FILE` is pinned for the identical reason, and to the exact
path `AppStdout`/`AppStderr` already write to, since `/admin/logs`
relays through this same file and has to agree with where NSSM is
actually writing it.

## Why does assertNoBrokenTableForms exist?

A `<form>` can't legally wrap a `<tr>`/`<td>`.<br>Browsers silently
relocate or drop it during HTML parsing, so inputs "inside" it are
never actually part of it and don't get submitted, which caused a
real bug: per-server checkboxes on the accounts page silently reset
on every save.<br>A functional test that posts hand-built bodies via
`fetch()` can't catch this at all, since it skips browser HTML parsing
entirely, so this check has to run against the actual served markup.

## Why does this test run the bootstrap with vm instead of just checking it's present?

This exact function shipped four broken versions in a row to a real
production deploy with nobody catching it, including one break from a
`\d` escape silently getting eaten by Node's own template-literal
parsing.<br>`server.js`'s source has to double-escape backslashes
precisely so the *browser* receives a working regex, a mistake
invisible by reading the source and only caught by running what
actually reaches the browser, which is what `node:vm` does here
against a stub DOM.

## Why is node_modules rebuilt fresh instead of copied?

It's rebuilt from scratch (`npm ci --omit=dev`) in a scratch
directory, not copied from the working tree's own install.<br>That
keeps devDependencies (`esbuild`, `postject`) out of every shipped
archive, and makes the lockfile the single source of truth for what's
actually in it.
