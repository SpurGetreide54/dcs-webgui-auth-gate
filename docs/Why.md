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
their own cookie before their own next page load.<br>That assumption
doesn't quite cover `inviteUrl`: unlike `error`/`notice`, which are
only ever displayed as text, it becomes a real `<a href>`, and the
cookie's own origin isn't guaranteed to be the same browser's own
tampering (a sibling subdomain could set it too). `readFlash()` in
`src/flash.js` only lets it through when it starts with `http://` or
`https://`, closing that gap without needing to sign the cookie.<br>
`setFlash` also sets `secure: COOKIE_SECURE`, matching
`setSessionCookie`'s own flag, since the cookie can carry that same
live invite URL: a plain-http request in the 10 second window it
lives for would otherwise send a bearer credential in cleartext.

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
single proxied request, independent of token freshness, and also
re-checks that the session which minted the token is still live
(not logged out, not expired), so logout and password change evict
the control channel too, not just the session cookie itself.

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

## Why does AUTH_GATE_STATE_DIR not replace the older vars?

`WEBGUI_STATIC_PATH`, `ACTIVE_SLOT_PATH`, `AUTH_GATE_LOG_PATH`, and
`SQLITE_PATH` were four independent values a production `.env` had to
get right, each pointing outside either A/B slot.<br>`AUTH_GATE_STATE_DIR`
replaces that with one directory, deriving the other four as fixed
sub-paths (`<dir>/webgui-static`, `<dir>/active-slot`,
`<dir>/auth-gate.log`, `<dir>/auth-gate.sqlite`).

Renaming the old vars outright would break every existing deployment's
`.env` on upgrade with no warning. Instead, `src/stateDir.js` lets any
old var still set win over `AUTH_GATE_STATE_DIR` for that one path, and
the server logs a deprecation warning at startup (listing exactly
which old vars are still in play) without refusing to start. A future
version can drop the old vars once deployments have had time to
migrate.

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

## Why does getSessionAdmin report a cookie-refresh flag?

`sessions.expires_at` already slides on every authenticated request,
but the browser's own `dcs_session` cookie (a fixed 12h `maxAge`) was
only ever set at login, setup, or invite redemption, so it expired at
hour 12 regardless of activity, contradicting `SESSION_TTL_SECONDS`'s
own "12h sliding idle timeout" comment.<br>Reissuing the cookie on
every single request would work too, but adds a `Set-Cookie` header
to every response for no reason; comparing `expires_at` against the
same threshold the DB row already uses means the cookie only gets
reissued once an hour of real idle time has actually passed, same
cadence as `src/controlTokens.js`'s own slide.<br>`requireAuth` takes
`onCookieRefreshNeeded` as a parameter, rather than importing
`setSessionCookie` directly, because that function (and the `secure`
cookie flag it needs) lives in `server.js`, not `auth.js`.<br>The
`sessions.expires_at` DB write piggybacks on the same flag now,
instead of running on every authenticated request: once a request
already falls inside the cookie-refresh window, sliding the DB row
in step costs nothing extra, and outside that window there's nothing
for the write to accomplish that the next in-window request won't
also do.

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

## Why does any-mission exist alongside view?

The permissions matrix lets a site admin grant `upload` (or
`download`, or `delete`) alone, with no `view`, but `GET
/s/:slug/missions` used to gate on `view` specifically, leaving an
upload-only admin with no way to reach the one page the upload form
lives on: a grantable permission that couldn't be used.<br>The
mission list itself had the same narrower gate (`access.canView`
alone, in both `missionsPage` and the agent fetch in
`renderMissionsPage`), which would have left a download-or-delete-only
admin on a page with nothing to select from, so both now check
`canView || canDownload || canDelete`, since the list is also how such
an admin picks what to act on, not just how a view-only admin reads
it.<br>`upload`'s own form stays gated on `canUpload` alone; it needs
no list.

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
seconds apart.<br>That db cooldown's own window is a fixed 60 seconds,
shorter than `applyUpdate()` can genuinely run (download, extract,
`npm install`, two agent relay calls of up to 60 seconds each), so a
second click after the window lifts but while the first run is still
going needs its own guard: an in-process `updateInFlight` flag,
`src/updateCheck.js`'s `isUpdateInFlight()`, set for as long as this
process's own `applyUpdate()` call is actually running. Both guards
stay: the db cooldown survives a restart, so a crash mid-update still
blocks a retry for the rest of its 60 seconds; the in-process flag
covers whatever that fixed window doesn't.

## Why does update_state track last_succeeded_at separately from last_checked_at?

A check that fails every hour must still update `last_checked_at`
every time it runs, or `/admin/update`'s "Last checked" label and the
failure's own log line would be the only trace that anything happened
at all. But the "update check keeps failing" diagnostic
(`isUpdateCheckStale()`) needs to know the last genuine success, not
the last attempt — reading `last_checked_at` for that would mean a
check that always fails but always updates that timestamp can never
be detected as stale, defeating the diagnostic entirely.
`last_succeeded_at` is set only on `checkForUpdate()`'s success path
(an update found, or confirmed already current — anything that didn't
throw), never from its catch branch.

## Why does diagnostics mirror updateCheck.js's own shape?

`src/diagnostics.js` (`/admin/diag`) needed the exact same shape
`updateCheck.js` already has: an immediate first run, then
`setInterval(...).unref()` so it never keeps the process alive on its
own, swallowing each cycle's own errors into `console.warn`, and
always recording the attempt into a single-row table either way
(`diagnostics_state`, same `id = 1` convention as `update_state`).
Rather than invent a second pattern for the same problem, it reuses
the proven one.

This did introduce one coupling the other direction: a successful
`applyUpdate()` is also the signal that clears a previously-detected
rollback (a fresh update with no new rollback is the "resolved"
signal). `updateCheck.js` requires `diagnostics.js` for that, but only
inside `applyUpdate()` itself, not at module load time, so the two
files never form an actual circular require.

`clearRollback()` marks the rollback resolved rather than erasing
`rollback_detected_at` outright. Erasing it would make a follow-up
check think no rollback had ever happened, when what actually
happened is the update succeeded and the rollback is now stale.
Marking it dismissed reuses the same field an admin's own manual
dismiss already writes, keeping the history intact through the one
state transition the diagnostics table already has.

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
each version's `X.Y.Z` numeric triple and, on a tied triple, a
hand-written SemVer prerelease comparison (no `semver` dependency
needed) so a pre-release install can still take the final release of
the same triple -- `1.5.0-alpha` to `1.5.0-beta` to plain `1.5.0` --
and only treats a strictly greater manifest version as an
update.<br>`checkForUpdate`'s own check
only guards what gets cached into `update_state` for display;
`applyUpdate()` re-runs the identical check itself, right after
fetching its own verified manifest, so the guard holds no matter how
an install gets triggered, not only through a prior `checkForUpdate`
call.<br>No deliberate-rollback path exists through this channel: the
automatic, local, crash-triggered rollback unit already covers a bad
release's real failure mode without touching GitHub at all.

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
waiting minutes to find that out. This same reasoning, not just the
relay's own call, is why `agentClient.js` applies it as every agent
call's default timeout, not only this one's.

## Why does agentClient read its env vars lazily?

`MISSION_AGENT_URL`/`MISSION_AGENT_TOKEN` used to be read once, at
module load, independently in four different files.<br>A module-level
read is exactly what forced `test/diagnostics.test.js` to bust
`require.cache` and re-require `diagnostics.js` every time a test
needed a different value -- a dance that would otherwise need
extending to every module that reads these vars.<br>Reading
`process.env` fresh inside `agentFetch`/`isConfigured`/`getUrl`/`getToken`
at call time means any test can just set the env var before calling,
no re-require needed, for every caller at once.

## Why does the auth-gate relay the agent's update?

The agent has no internet access of its own by design, kept off the
host's internet-facing side (see
[Deployment Topology](Deployment-Topology.md)).<br>The auth-gate is
the one that reaches GitHub, so it hands the bytes onward over the
existing internal auth-gate to agent channel instead.

## Why does the agent verify the staged build's signature itself?

Before this, `/self-update/stage` only checked the uploaded bytes
against an `X-Sha256` header the same caller supplied -- that
authenticates nothing by itself, since a leaked bearer token plus the
right network position could push any exe past it.<br>The real
signature check against the key-rotation trust root happened only on
the auth-gate side, before it relayed the bytes onward (see "Why does
the auth-gate relay the agent's update?" above); anyone who could
still reach the agent after that hop could push unsigned code.

A key baked into `agent.exe` at build time can't work: the primary
signing key rotates independently of app releases
(`scripts/release/rotate-key.js`), and a fixed key would reject a
manifest signed after a legitimate rotation, bricking self-update
until someone fixes it by hand.<br>So the agent keeps its own
persisted trust file (`agent-key-state.json`, seeded from the same
`keyRotationConstants.js` placeholder keys db.js seeds `key_state`
from) and replays whatever rotation history the gate forwards in
`X-Key-State-History` through a ported copy of `keyRotation.js`'s own
`verifyKeyState` -- the agent can't require that module directly, since
it pulls in `db.js`'s native sqlite, wrong for a standalone Windows
exe.<br>Once the trust file reflects any relayed rotations,
`/self-update/stage` verifies `X-Manifest-Signed`/`X-Manifest-Signature`
against the (possibly just-updated) trusted primary key, then checks
the uploaded bytes' own hash against that signed manifest's `"agent"`
download entry -- not a caller-supplied header -- which is what
actually closes the gap.

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

## Why does a colliding upload auto-rename instead of overwriting?

`upload` only ever lists as "Uploading a `.miz` file" in
`docs/Roles-and-Permissions.md`; nothing says it can replace an
existing mission, and delete is otherwise "move aside, never
unlink."<br>An admin with only `upload` overwriting a same-named
mission outright would bypass both `delete`'s permission gate and
its trash-not-unlink guarantee.<br>Auto-renaming the *new* upload to
`<name>(1).miz`, `<name>(2).miz`, ... — file-manager style, the
existing mission on disk never touched — avoids that bypass without
needing a new permission or a confirm-overwrite round trip.

## Why does the agent check typeof before every path operation?

`path.basename`, `path.join`, and friends throw `ERR_INVALID_ARG_TYPE`
on anything that isn't a string, and that throw happens inside an
async Express 4 handler with no try/catch, so it becomes an unhandled
rejection and kills the whole process.<br>Confirmed by reproducing it:
`POST /missions/Inst/download` with `{"missions":[{"a":1}]}` crashed
the agent via `path.basename`, and an array `instance_name` on
`/upload` crashed it via `path.join`: a single-element array like
`["Inst"]` stringifies to `"Inst"` and passes `INSTANCE_NAME_RE.test()`
by coercion, then reaches `path.join` as the array itself, not a
string.<br>Checking `typeof === "string"` first, before any other
validation, closes both without having to reason about what every
downstream `path.*` call would do with the wrong type.

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

## Why do download, trash and restore require .miz, like upload already did?

Upload and the mission list already restricted to `.miz`; download,
trash and restore did not, only enforcing containment and rejecting
dot-led names.<br>This tool only ever manages missions, not arbitrary
files that happen to sit in the same folder, so a user with
`download` or `delete` could otherwise reach a `.lua`, `.trk`, or
leftover `.tmp` file the UI never lists.<br>`safeMissionPath`'s
`requireMiz` option stays optional rather than unconditional, because
restore resolves a *trash entry's* own on-disk name first (ending in
`.<timestamp>`, never `.miz`), then separately checks the parsed
*original* name against the same rule once `parseTrashEntryName` has
split the suffix back off.

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

## Why does multer need defParamCharset: "utf8"?

multer's own default, `'latin1'`, reads a multipart filename's UTF-8
bytes as latin1, mangling anything non-ASCII — the deployer community
is German-speaking, so names like `Übung` are expected, not an edge
case.<br>Without this, the gate's own upload route mangles the name
once, then forwards it to the agent in a new `FormData` that fetch
re-encodes as UTF-8, which the agent's multer (with the same default)
decodes as latin1 a second time, doubly garbling the file on
disk.<br>Both multer instances — the gate's upload route and the
agent's `/upload` — need the fix, not just one.

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

## Why doesn't the webgui proxy fall back to a default port?

It used to, to 8088 when an instance's `autoexec.cfg` had no
`webgui_port` line.<br>Two unconfigured instances, or one unconfigured
instance sharing a host with another instance that happens to use
8088, would collide: an admin scoped to the unconfigured instance's
token still got proxied straight into the other instance's control
port, breaking the scoping `src/serverProxy.js` otherwise
guarantees.<br>Confirmed no real deployment relies on the
fallback -- every instance gets an explicit port via
`/admin/servers/webgui-ports` -- so `requireWebguiPort` now 502s
instead of guessing.

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
in, but the update-available and diagnostics sidebar icons both have
to show on every authenticated page.<br>Threading one more parameter
through every single page function's call site for a single cheap
synchronous read isn't worth it, and `updateCheck.js`/`diagnostics.js`'s
own DB reads are single-row `SELECT`s, not network I/O, so this stays
fast.

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

## Why is there a separate per-IP login throttle?

The existing per-username bucket (`ip:username`) lets one IP spray
unlimited usernames, five wrong passwords each, with no ceiling on
total attempts or on the bcrypt-cost-12 compute each one
costs.<br>`RATE_LIMIT_IP_MAX_ATTEMPTS` (20, four times the
per-username ceiling) adds a second bucket keyed on IP alone, under
its own `"login-ip"` purpose, checked alongside the per-username one
in `/login` — either ceiling being hit blocks the attempt. 4x gives
enough headroom for a few real usernames behind one shared NAT
address to each mistype a password a couple of times without
tripping it.<br>Unlike the per-username bucket, this one is never
cleared on a successful login: one correct login out of a spray
shouldn't reset the count, since the bucket exists specifically to
bound a spray across many usernames, not to track one legitimate
user's own mistakes.<br>This is defense-in-depth on top of the real
network boundary, not a substitute for it — see
`docs/Deployment-Topology.md`'s own note on `trust proxy` and
`X-Forwarded-For`.

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

## Why does change-password use a separate rate-limit bucket from login?

Change-password now rate limits the current-password check, through
the same `login_attempts` machinery `/login` uses (`rateLimitKey`'s
`purpose` parameter, default `"login"` so every existing `/login`
call site stays untouched), under its own `"change-password"` prefix
rather than sharing `/login`'s bucket.<br>A stolen-session attacker
guessing the current password here would otherwise also lock the
real owner out of `/login` itself, which is the one path that still
works once the session is dead.<br>Keyed on `req.admin.username`
(the authenticated identity, from the session), not a body field.

## Why does /s/:slug redirect to add its own trailing slash?

Express's default non-strict routing already matches a bare `GET
/s/foo` to the same `app.get("/s/:slug/", ...)` handler that serves
`/s/foo/`, so the index HTML loads either way.<br>The problem is the
browser's address bar, not the server: it stays at `/s/foo`, and the
served page's own relative asset URLs (`js/app.js`, `styles.css`)
resolve against that missing segment, landing on `/s/js/app.js`, which
`requireServerAccess` then answers with "Unknown server." for the slug
`js`.<br>The handler checks `req.path` first (it reports
`/s/foo` or `/s/foo/` exactly as received, unlike `req.originalUrl`
which also carries the query string) and redirects 302, not 301, so a
later slug rename is never cached by the browser.

## Why does webgui-ports confirm use hidden fields instead of a signed token?

Only site admins reach `/admin/servers/webgui-ports`, so there's no
adversary who'd benefit from tampering with their own hidden
fields.<br>The guard this closes is a race with reality changing
between review and click — a server added, or an instance's
`autoexec.cfg` edited, in between — not distrust of the reviewer, so
a plain hidden `instance_name`/`port` pair per reviewed row, compared
server-by-server against a freshly recomputed proposal on confirm, is
enough.<br>The comparison is order-based, safe because
`serversDb.getAllServers()` orders by `id`, a stable order.

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

## Why does the index injection use a function replacer instead of a string one?

A string second argument to `String.prototype.replace` treats `$&`,
`` $` ``, `$'`, `$$` and `$<name>` as special, expanding them against
whatever the regex matched.<br>`APP_JS_SCRIPT_RE` has no capture group
today, so `$1` in the bootstrap stays literal by accident, not by
design -- adding a capture group later, or a `$`-containing token
anywhere in the bootstrap script, would silently corrupt the injected
JS with no error, just a webgui that shows "server not
responding".<br>A function replacer's return value is inserted
verbatim, with no such expansion, closing that off for good regardless
of what the regex or the bootstrap script later become.

## Why does the fetch shim rebuild a Request instead of just reading its url?

A plain string is the common, confirmed-real case (`fetch(url, options)` is
the only shape the actual synced DCS webgui bundle ever calls), so that
path's existing two-argument `nativeFetch.call(this, rewritten, init)`
shape is left untouched on purpose.<br>A `Request` object carries its own
method, headers and body; reading only its `.url` and discarding the rest
would silently turn a POST into a GET with no body.<br>`new Request(rewritten,
input)` rebuilds one at the rewritten url while copying everything else
from the original by standard Fetch-spec structural property access -- this
is defensive hardening for a call shape the current bundle doesn't use,
not a fix for an observed bug, since `webgui-sync` can point this app at a
different DCS install (and so a different bundle) at any time.

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

## Why does every async handler need asyncHandler?

Express 4 wraps a synchronous handler's own throw in a try/catch, but
has no idea an `async` handler's returned promise can reject, so a
rejection inside one becomes an unhandled rejection instead of a
caught error, taking the whole process down on the very next bug, not
just the one that happened to be found and fixed first.<br>Confirmed
present-day, not just a future risk: before this fix, `GET
/missions/:instanceName`'s `Promise.all`/`fs.stat` call, `POST
/missions/:instanceName/trash`'s `fs.mkdir`, `src/server.js`'s own
`GET /s/:slug/missions` (a malformed mission-agent reply crashed the
whole process, not just that one request), and several other routes
in both `src/server.js` and `src/agent.js` ran with no `try`/`catch`
at all.<br>`(req, res, next) => fn(req, res, next).catch(next)` is
hand-rolled rather than a dependency (`express-async-handler` or
similar) because it's one line and both files already minimize their
own dependency surface.

## Why does the crash handler exit immediately with no graceful close?

Reaching `unhandledRejection`/`uncaughtException` at all means a bug
got past every `try`/`catch` and `asyncHandler`, so the process is in
an unknown state; attempting a graceful shutdown (closing the DB,
draining in-flight requests) risks hanging or corrupting further
rather than just exiting.<br>Logging first, two-tier (`console.error`
for a short always-visible line, `console.debug` for the full detail
behind `/admin/logs`'s verbose filter) matters more here than a clean
shutdown, since the service supervisor (`Restart=always`) brings the
process back up immediately either way.

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

It does read `process.env.ACTIVE_SLOT_PATH`/`AUTH_GATE_STATE_DIR`
directly, the same precedence `stateDir.js` uses for that one path.
Reading an env var needs no package, so this doesn't break the
zero-dependency rule above, and without it a custom `--state-dir`
install would have the launcher and the real app disagreeing about
where the A/B flip lives.

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

## Why does the service unit redirect stdout/stderr to their own file, not the app log?

A true native crash (a segfault, a V8 fatal error) never reaches
`uncaughtException`, since no JS runs at all to catch it; the OS-level
`StandardOutput=append:`/`StandardError=append:` redirect is the only
thing that can still capture it.

It used to point at the same `auth-gate.log` file `AUTH_GATE_LOG_PATH`
already writes structured lines to, mirroring the Windows side's
`AGENT_LOG_FILE`/NSSM `AppStdout`/`AppStderr` pairing, so one crash
dump could land mid-file without a viewer change (`appLog.js`'s
`readRecentEntries` already renders a line that fails to parse as
JSON as a raw row instead of breaking the page). That turned out to
cause two confirmed problems, both reproduced directly rather than
just reasoned about:

1. **Every ordinary log line was written twice.** `appLog.js`'s
   `installConsoleCapture()` calls both the original `console.*`
   method (real stdout/stderr, captured by the OS redirect into
   `auth-gate.log`) and its own `appendLine()` (a second, direct
   `fs.appendFileSync` into the same file). One `console.log()` call
   produced two lines — the plain message and the structured JSON —
   doubling every row `/admin/logs` showed.
2. **Rotation leaked disk, invisibly.** `appendLine()` rotates by
   `fs.renameSync`-ing the live file to `.1`. systemd opens its
   `StandardOutput`/`StandardError` fd once, at service start, and
   keeps it open for the service's whole lifetime — a rename doesn't
   follow that fd. After one rotation, systemd's fd keeps writing into
   the now-`.1` file; after a second, that file is itself renamed away
   again, and systemd's fd is left attached to a fully unlinked inode —
   invisible to `ls -l` on the directory, discoverable only via `ls -l
   /proc/<pid>/fd`, growing without bound for as long as the service
   runs.

The Windows mission agent doesn't share this: `agent.js`'s own
`installConsoleCapture()` only ever calls the *original* console
method with the JSON-formatted line — there's no second, independent
file write or rotation logic anywhere in `agent.js`. NSSM's
`AppStdout`/`AppStderr` is the only writer and `AppRotateOnline=1` the
only rotator, and NSSM reopens its own handle on rotation, so there's
no second writer and no stale-fd race to begin with.

The fix gives the OS-level redirect its own dedicated
`auth-gate-native-crash.log`, decoupled from the self-rotated
structured log (`scripts/linux/install.sh`'s `NATIVE_CRASH_LOG_PATH`).
A genuine crash is still captured — that redirect's only job — and
`/admin/logs` no longer doubles every line. The cost: a crash dump no
longer lands inline in the same timeline `/admin/logs` shows, so an
admin checks the dedicated file separately over SSH. That file sees
nothing under normal operation (only a real segfault/V8 fatal writes
to it, which kills the process and triggers `Restart=always`), so its
own unbounded growth is no longer an invisible leak, just an ordinary,
visible, by-name file that only ever grows on a rare real crash.

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

## Why does DcsSavedGamesRoot default to the installing user?

DCS server installs conventionally run as whatever account was used
to install the service, and the service itself always runs as
LocalSystem (no `-ObjectName` is ever set in the NSSM registration
block below), so there's no ACL mismatch between the installing
user's own "Saved Games" folder and the account the service runs
under.<br>Auto-detecting which account DCS actually runs under was
considered and rejected: the installing user's own folder is right
for the common case (one admin installs both DCS and this agent), and
a dedicated-account setup (the `dcsservice` examples throughout this
script and its docs) already needs `-DcsSavedGamesRoot` passed
explicitly for other reasons, so there's no real case that falls
through a gap.<br>The post-check warning (an empty-but-existing
folder) is a hint, not a hard failure, since an empty folder is also
just what a brand new DCS install looks like before its first server
is ever created.

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

## Why are bind address and firewall remote-address two separate install params?

`-AgentBindAddress` and `-AuthGateAddress` cover two independent
axes: bind address is which local interface the agent listens on,
firewall remote-address is which remote address may connect.<br>A
host could need one without the other — a single-NIC host has
nothing to bind narrower, but still wants the firewall scoped — so
collapsing them into one parameter would force a false coupling.<br>
Both default to open, with a loud warning rather than a refusal to
install, matching this script's existing `-DcsSavedGamesRoot`
precedent: an unattended re-install must not start failing just
because these two optional flags weren't repeated.

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

## Why does install.sh leave an existing active-slot file alone?

`scripts/linux/install.sh` is designed to be safe to re-run, the same
property `install.ps1` already has on the mission-agent side.<br>The
one-time manual prerequisites it replaces always wrote `active-slot`
unconditionally, because they were only ever meant to run once. A
script meant to be rerun cannot do the same: a production deployment
that has since self-updated onto slot b would get silently rolled
back to slot a on every rerun, just from an admin tweaking an
unrelated `.env` value. Permissions on the file are still fixed every
run; only its content is write-once.

## Why does install.sh read the deployed unit file for its rerun defaults, not .env?

Install directory and service account are not `.env` keys, so the
usual "current `.env` value as the default" rule has nothing to read
for them. Each is still remembered across a re-run anyway, taken from
the already-installed `dcs-webgui-auth-gate.service`'s own
`WorkingDirectory=`/`User=` lines, the one fixed, always-present
source of truth checked before `.env`'s own location can even be
known.

## Why is .env chmodded 600 on every write, instead of once at the end?

`set_env_value` writes through a `touch`, an awk redirect into a
`.tmp` file, and a `mv`.<br>`mv` on the same filesystem is a rename,
so the file that survives it carries whichever mode the `.tmp` file
had, not whatever mode the old `.env` had — a single `chmod` at the
very end of `install.sh` would still leave every intermediate write
briefly world-readable under the default `0644` umask.<br>Chmodding
right after `touch` (first creation) and right before every `mv`
(every later call) closes that window on both paths.<br>`UMask=0077`
in the service unit covers the other half: every file the running
service creates itself (the sqlite db plus its `-wal`/`-shm` files,
`auth-gate.log`, the webgui-sync scratch and backup dirs) is private
from creation, not just `.env`.<br>The rollback unit, which appends
to the native-crash log, needs neither: it runs as root with no
`User=`/`UMask=` of its own, and root bypasses file-mode checks
entirely on Linux, so tightening that file's mode can't block it.

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

## Why doesn't applyUpdate() run npm install in the new slot?

It used to, right after staging. Removed after reproducing on the
real production VM: that service account is created with `useradd
--no-create-home`, so `HOME` resolves to `/nonexistent`.<br>The moment
npm needed to touch its cache for anything beyond a no-op, it died
with `EACCES: permission denied, mkdir '/nonexistent'`, aborting the
whole update before the active-slot pointer ever flipped.

The staged slot's `node_modules` is already complete and correct: it
comes straight from the same archive `npm ci --omit=dev` built
against its own pinned lockfile, see "Why is node_modules rebuilt
fresh instead of copied?" above.<br>There's nothing left for a second
`npm install` to do, confirmed on the real VM too: run against that
already-correct `node_modules`, the same command reports "up to date"
and exits clean without ever touching the cache.

The one native dependency, `better-sqlite3`, uses N-API
(`NAPI_VERSION=10` in its own `binding.gyp`) and ships a prebuilt
binary per platform, both specifically so it never needs rebuilding
for a different Node version. Whatever the original motivation was,
an ABI mismatch was never actually a risk for this dependency.

## Why is key-state/rotation a separate signed record?

`signed_updates.json` already has its own trust root (`key_state`'s
primary key, checked on every routine release).<br>Folding key
rotation into that same file would force its
signature to become conditional — dual-signed only in months a
rotation happens to land — and would recouple release cadence to
rotation cadence for no reason. A separate record, on its own fixed
`key-state` tag, lets a leaked key get revoked the moment it's
noticed, with no new app version and no change to how
`signed_updates.json` itself is built or signed.

## Why is key_state.json an append-only history instead of a single record?

A rotation record's vouch signature is checked against whatever the
*surviving* slot's key the verifying install currently has, not
whatever the record's own author had.<br>When `key_state.json` held
only the newest record, overwritten in place, an install that missed
two rotations between hourly checks (secondary rotated, vouched by the
old primary; then primary rotated, vouched by the *new* secondary)
only ever saw the second record. Its own stored secondary was still
the old one, so that vouch could never verify, and the install
rejected that record and every later one forever. That is the exact
failure key rotation exists to avoid, happening to key rotation itself.

`key_state.json` is now a JSON array of every rotation record ever
issued, oldest first, never pruned (ed25519 records are tiny; even
decades of rotations stay negligible). `checkKeyState()` replays the
whole array in order on every check, re-reading trusted state between
records, so a record vouched by a key the same batch just rotated in
verifies correctly. However far behind an install falls, it just has
more records to replay; it can never get permanently stuck. Fixed
before the feature's first real use: no `key_state.json` had ever been
published, so there was no live consumer of the old single-record
format to migrate.

## Why does verifyManifest read key_state instead of a hardcoded constant?

Key rotation only matters if revoking a leaked key actually changes
which key the update path trusts, not just a record in
`key_state`.<br>`verifyManifest()` now reads
`key_state.primary_public_key_pem` fresh on every check, so a
rotation applied by the hourly `checkKeyState()` poll takes effect on
the very next update check, with no new app release. Secondary is
never accepted here, only primary, matching the existing
single-signature manifest format; secondary stays reserved for
vouching a primary rotation record, which already carries two
signatures.

A production deployment was already live when this was wired up,
trusting only the old hardcoded key. That release's own manifest had
to stay signed with the old key for that reason alone; only the
release after it could sign with the new primary key, by explicit
`sign-updates.js --key` override.

## Why does key_state seed rotated_at with a fixed date instead of install time?

`verifyKeyState()`'s replay guard rejects any rotation record whose
`rotated_at` isn't strictly newer than what's already trusted, which
is what stops an attacker replaying an old, previously-valid
record.<br>Seeding `primary_rotated_at`/`secondary_rotated_at` with
the install's own first-run time meant a real rotation published
before a given install's first run was rejected by that install
forever, keeping it on a key that may have already been revoked. The
seed is instead `INITIAL_KEY_ROTATED_AT` in
`src/keyRotationConstants.js`, fixed at the date the two keys
themselves were created and the same on every install, so it is older
than any real rotation will ever be. No guarded migration was needed
for this fix: `key_state` had not yet shipped in a released version
when the bug was found.

## Why was a third hardcoded key, guarding a compromised GitHub account, dropped?

Neither the primary nor the secondary private key ever touches
GitHub — both live in `local-only/keys/` or the maintainer's own
password manager.<br>`verifyKeyState()`'s own signature checks already
mean an attacker who only has GitHub account or token access can, at
most, delete or replace the `key-state` release's asset with
something that fails verification (denial of service), never get a
forged rotation accepted. A third key would guard against a threat
that doesn't exist here.

## Why is tooling split into automatable and user-run-only halves?

The secondary private key is the only thing that makes rotating
primary a real two-key decision rather than theater.<br>As long as it
is read only by a script the user runs themselves, in their own
terminal, it never has to pass through any other machine, service, or
automated tool, no matter where the rest of the tooling lives. That's why
`sign-key-state-with-secondary.js` is a separate, minimal script that
reads the key and prints only the resulting signature — never the key
itself, never a finished, publishable file — leaving the actual
publish step to `rotate-key.js primary-finalize`, which only ever
touches that pasted-back signature.

## Why do key rotation constants live in their own file?

`db.js` seeds `key_state`'s initial row from the two hardcoded public
keys, and needs them at module load time, before anything else is
set up.<br>Putting them in `src/keyRotation.js` instead would force
`db.js` to require a module that itself requires `db.js`, the same
circular-dependency shape `updateConstants.js` already exists to
avoid for the version-check side.

## Why is next_target_rotation_at jittered?

A fixed 30-day clock would make the exact day of the next rotation
predictable from the previous one's own timestamp.<br>Jittering it a
few days either way, computed fresh each time a rotation is applied,
only helps against an attacker trying to time an attack around that
moment — it does nothing to shrink how long an already-stolen key
stays usable before someone notices and rotates it by hand.

## Why is there no admin UI surface for key rotation?

This is not a deployer or site-admin concern at all — every
deployment trusts the same two keys this project's own maintainer
controls, the same person who already runs `rotate-key.js` by
hand.<br>No individual deployment ever rotates its own keys, so
there is nothing for an admin UI to expose. Checking `key_state`
directly in the database, the same way `update_state` is checked, is
enough for the one person who ever needs to.
