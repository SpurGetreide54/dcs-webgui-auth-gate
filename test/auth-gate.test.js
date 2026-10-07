const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const vm = require("node:vm");

function startDummyHttpServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// A <form> can't legally wrap a <tr>/<td>. Browsers silently relocate or
// drop it during HTML parsing, so inputs "inside" it are never actually
// part of it and don't get submitted. This test caught a real bug from
// exactly that: per-server checkboxes on the accounts page silently reset
// on every save. Functional tests that POST hand-built bodies via fetch()
// can't catch this at all, since they skip browser HTML parsing entirely.
// This has to check the actual served markup.
function assertNoBrokenTableForms(html, context) {
  assert.doesNotMatch(html, /<tr>\s*<form/i, `${context}: a <form> must not be nested directly inside a <tr>`);
  const formIds = new Set([...html.matchAll(/<form[^>]*\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const match of html.matchAll(/\bform="([^"]+)"/g)) {
    assert.ok(formIds.has(match[1]), `${context}: an input references form="${match[1]}" but no <form id="${match[1]}"> exists`);
  }
  // An empty out-of-band <form id="...">...</form> (no fields of its own,
  // existing only so other rows' inputs can reference it via form="...")
  // must carry class="row-form" -- see the rule at .row-form in style.css.
  // Without it, the plain `form { ... }` rule renders it as a visible
  // blank box.
  for (const match of html.matchAll(/<form\s+id="[^"]+"[^>]*><\/form>/g)) {
    assert.match(match[0], /class="row-form"/, `${context}: an empty out-of-band form must carry class="row-form" or it renders as a visible blank box: ${match[0]}`);
  }
}

function extractCookie(res) {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  return setCookie.split(";")[0];
}

function tempSqlitePath(label) {
  return path.join(os.tmpdir(), `auth-gate-test-${label}-${crypto.randomBytes(6).toString("hex")}.sqlite`);
}

function cleanupSqlite(sqlitePath) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(sqlitePath + suffix, { force: true });
}

let app, db, serversDb, invitesDb, serverProxy;
let dummyAgent, dummyAgentPort;
// The app now makes more than one agent call per page render (e.g. an
// upload POST followed by a list GET to refresh the page), so a single
// overwritten "last received call" can no longer be trusted to still hold
// the call a given assertion cares about. This keeps every call, so a
// specific one can be found by method+path regardless of what else the
// app also happened to call afterward.
let dummyAgentCalls;
function lastAgentCall(method, pathPrefix) {
  return dummyAgentCalls.filter((c) => c.method === method && c.url.startsWith(pathPrefix)).pop();
}
let sqlitePath;
const AGENT_TOKEN = "test-agent-token";

test.before(async () => {
  dummyAgent = await startDummyHttpServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      dummyAgentCalls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks) });
      res.writeHead(200, { "Content-Type": "application/json" });
      // A list GET needs a real { missions: [...] } shape, not the generic
      // { ok: true } every other stubbed endpoint here returns.
      res.end(req.method === "GET" && req.url.startsWith("/missions/") ? JSON.stringify({ missions: [] }) : JSON.stringify({ ok: true }));
    });
  });
  dummyAgentPort = dummyAgent.address().port;
  dummyAgentCalls = [];

  sqlitePath = tempSqlitePath("main");
  process.env.SQLITE_PATH = sqlitePath;
  process.env.COOKIE_SECURE = "false"; // plain http in tests, no TLS
  process.env.MISSION_AGENT_URL = `http://127.0.0.1:${dummyAgentPort}`;
  process.env.MISSION_AGENT_TOKEN = AGENT_TOKEN;

  app = require("../src/server");
  db = require("../src/db");
  serversDb = require("../src/servers");
  invitesDb = require("../src/invites");
  serverProxy = require("../src/serverProxy");
});

test.after(async () => {
  await new Promise((resolve) => dummyAgent.close(resolve));
  db.close();
  cleanupSqlite(sqlitePath);
});

test("full flow: setup, login, dashboard filtering, accounts, proxy, missions, logout", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  db.prepare(
    "INSERT INTO servers (slug, name, instance_name) VALUES (?, ?, ?)"
  ).run("training", "Example Server - Training", "training");
  db.prepare(
    "INSERT INTO servers (slug, name, instance_name) VALUES (?, ?, ?)"
  ).run("community1", "Example Server - Community 1", "community1");

  try {
    // --- /setup creates the first admin with full access ---
    const setupRes = await fetch(`${base}/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=siteadmin&password=correct-horse-battery-staple",
      redirect: "manual",
    });
    assert.equal(setupRes.status, 302, "setup should redirect after creating the first admin");
    const siteAdminCookie = extractCookie(setupRes);
    assert.ok(siteAdminCookie, "setup should set a session cookie");

    // /setup is a one-time door. Must 404 now that an admin exists.
    const setupAgainRes = await fetch(`${base}/setup`);
    assert.equal(setupAgainRes.status, 404, "/setup must 404 once an admin account exists");

    // --- dashboard shows the site admin's (full) access ---
    const dashRes = await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } });
    const dashHtml = await dashRes.text();
    assert.match(dashHtml, /Example Server - Training/);
    assert.match(dashHtml, /Example Server - Community 1/);

    // --- create a second admin with no permissions yet, no account mgmt ---
    const trainingServerId = db.prepare("SELECT id FROM servers WHERE slug = ?").get("training").id;
    const createRes = await fetch(`${base}/admin/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: "username=serveradmin&password=another-long-password",
      redirect: "manual",
    });
    assert.equal(createRes.status, 302);

    const serverAdminRow = db.prepare("SELECT * FROM admins WHERE username = ?").get("serveradmin");
    assert.equal(serverAdminRow.can_manage_accounts, 0, "new account must not default to site-admin");
    assert.equal(serversDb.hasServerAccess(serverAdminRow.id, trainingServerId), false, "a new account must start with no server access at all");

    // --- grant access + view (but not upload) on Training, through the
    // permissions-matrix popup's own endpoint -- one permission per call,
    // exactly how a cell click in the popup behaves. ---
    for (const permission of ["access", "view"]) {
      const grantRes = await fetch(`${base}/admin/accounts/${serverAdminRow.id}/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: siteAdminCookie },
        body: JSON.stringify({ server_id: trainingServerId, permission, granted: true }),
      });
      assert.equal(grantRes.status, 200);
    }

    // --- the accounts page must render popup state that matches what was
    // actually granted, not just accept the grant server-side. Regression
    // check for the getAccessibleServers() `server_id` gotcha (see
    // src/servers.js). ---
    const accountsHtmlAfterCreate = await (
      await fetch(`${base}/admin/accounts`, { headers: { Cookie: siteAdminCookie } })
    ).text();
    const serveradminRowHtml = accountsHtmlAfterCreate.slice(
      accountsHtmlAfterCreate.indexOf(">serveradmin<"),
      accountsHtmlAfterCreate.indexOf("</tr>", accountsHtmlAfterCreate.indexOf(">serveradmin<"))
    );
    const dataAccessMatch = serveradminRowHtml.match(/data-access="([^"]*)"/);
    assert.ok(dataAccessMatch, "serveradmin's row must render a Permissions button carrying its current grants");
    const decodedAccess = JSON.parse(dataAccessMatch[1].replace(/&quot;/g, '"'));
    const trainingGrant = decodedAccess.find((g) => g.server_id === trainingServerId);
    assert.equal(trainingGrant.access, true, "granted access must be reflected in the popup's data, not reset on page load");
    assert.equal(trainingGrant.view, true);
    assert.equal(trainingGrant.upload, false, "upload was never granted, so it must render as false");

    const loginRes = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=serveradmin&password=another-long-password",
      redirect: "manual",
    });
    const serverAdminCookie = extractCookie(loginRes);
    assert.ok(serverAdminCookie);

    // dashboard should show ONLY Training, not Community 1
    const restrictedDash = await fetch(`${base}/`, { headers: { Cookie: serverAdminCookie } });
    const restrictedHtml = await restrictedDash.text();
    assert.match(restrictedHtml, /Example Server - Training/);
    assert.doesNotMatch(restrictedHtml, /Example Server - Community 1/);

    // restricted account gets the read-only "My account" page, not a 403 --
    // its own row only, no site-admin column, no account-management actions
    const myAccountRes = await fetch(`${base}/admin/accounts`, { headers: { Cookie: serverAdminCookie } });
    assert.equal(myAccountRes.status, 200);
    const myAccountHtml = await myAccountRes.text();
    assert.match(myAccountHtml, /My account/);
    assert.match(myAccountHtml, />serveradmin</);
    assert.doesNotMatch(myAccountHtml, />siteadmin</, "My account must show only the logged-in admin's own row, not the full roster");
    assert.doesNotMatch(myAccountHtml, /Site admin/, "read-only view must not show the Site admin column");
    assert.doesNotMatch(myAccountHtml, /Add account/, "a non-site-admin must not see account creation");
    assert.match(myAccountHtml, /Change password/);
    assert.match(myAccountHtml, /<input type="checkbox" disabled checked>/, "own granted access must render as a checked, disabled checkbox");

    // restricted account must not reach Community 1's proxy
    const forbiddenProxy = await fetch(`${base}/s/community1/`, { headers: { Cookie: serverAdminCookie } });
    assert.equal(forbiddenProxy.status, 403);

    // restricted account has no access at all on Community 1, so the
    // missions page (gated on "view", not "access") must 403 there too
    const forbiddenMissionsNoAccess = await fetch(`${base}/s/community1/missions`, { headers: { Cookie: serverAdminCookie } });
    assert.equal(forbiddenMissionsNoAccess.status, 403);

    // on Training it has "view" but not "upload" -- the missions page
    // itself is gated on view alone, so it's reachable, but shows no
    // upload form
    const missionsPageRes = await fetch(`${base}/s/training/missions`, { headers: { Cookie: serverAdminCookie } });
    assert.equal(missionsPageRes.status, 200, "view access must be enough to reach the missions page");
    const missionsPageHtml = await missionsPageRes.text();
    assert.doesNotMatch(missionsPageHtml, /Upload mission/, "no upload rights means no upload form is shown");

    const forbiddenMissionUpload = await fetch(`${base}/s/training/missions/upload`, {
      method: "POST",
      headers: { Cookie: serverAdminCookie },
      body: new FormData(),
    });
    assert.equal(forbiddenMissionUpload.status, 403, "view without the upload flag must not allow uploading");

    // --- the real webgui's own static bundle is served under /s/<slug>/, as the site admin ---
    const webguiRes = await fetch(`${base}/s/training/`, { headers: { Cookie: siteAdminCookie } });
    assert.equal(webguiRes.status, 200);
    const webguiHtml = await webguiRes.text();
    assert.match(webguiHtml, /<div id="app">/, "must serve the real webgui's index.html, not a proxied response");

    // the control-port token bootstrap must be injected before app.js loads,
    // with a fresh token each page load. Nothing else lets the SPA's own
    // fetch() reach the control-port proxy.
    const tokenMatch = webguiHtml.match(/var TOKEN = "([0-9a-f]+)"/);
    assert.ok(tokenMatch, "index.html response must include the control-port token bootstrap script");
    const webguiRes2 = await fetch(`${base}/s/training/`, { headers: { Cookie: siteAdminCookie } });
    const tokenMatch2 = (await webguiRes2.text()).match(/var TOKEN = "([0-9a-f]+)"/);
    assert.notEqual(tokenMatch2[1], tokenMatch[1], "each page load must mint its own distinct token");

    // The bootstrap's fetch-rewrite logic itself, actually executed -- not
    // just checked for presence. This exact function shipped four broken
    // versions in a row to a real production deploy with nobody catching
    // it, including one break from a \d escape silently getting eaten by
    // Node's own template-literal parsing (server.js's own source has to
    // double-escape backslashes precisely so the *browser* receives a
    // working regex -- a mistake invisible by reading the source, only
    // caught by running what actually reaches the browser, which is what
    // this does).
    const bootstrapMatch = webguiHtml.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(bootstrapMatch, "index.html response must include an inline bootstrap <script> block");
    const bootstrapScript = bootstrapMatch[1];

    function runBootstrapFetch(requestUrl, { hostname, pathname }) {
      const calls = [];
      const context = { location: { hostname, protocol: "https:", href: `https://${hostname}${pathname}` }, URL, Headers };
      context.window = {
        fetch: async (url) => {
          calls.push(url);
          return { ok: true };
        },
      };
      vm.createContext(context);
      vm.runInContext(bootstrapScript, context);
      context.window.fetch(requestUrl);
      return calls[0];
    }

    const hostname = "panel.example.test";
    const pathname = "/s/training/";

    // The real DCS webgui's own hardcoded default backend URL, byte for
    // byte: a literal backslash before the port colon. A backslash right
    // after the host ends URL authority parsing for http(s) URLs, so an
    // unfixed regex here lets "8088" leak into the path and show up
    // doubled next to the port this rewrite sets correctly.
    const rewritten = runBootstrapFetch("http://127.0.0.1\\:8088/encryptedRequest", { hostname, pathname });
    assert.equal(
      rewritten,
      `https://${hostname}:${serverProxy.CONTROL_PORT}/encryptedRequest`,
      "must rewrite the real DCS webgui's malformed default backend URL to a clean same-host URL with no doubled port"
    );

    // A request for one of the app's own served files, same-origin under
    // BASE_PATH, must pass through untouched -- rewriting it too would
    // send the app's own JS/CSS/font requests at the control-port proxy
    // instead of this app's own static file server.
    const ownAsset = runBootstrapFetch(`${pathname}js/app.js`, { hostname, pathname });
    assert.equal(ownAsset, `${pathname}js/app.js`, "a request for the app's own served files must not be rewritten");

    // a path with no matching static asset must 404, not fall through to some proxy
    const missingAssetRes = await fetch(`${base}/s/training/does/not/exist.js`, { headers: { Cookie: siteAdminCookie } });
    assert.equal(missingAssetRes.status, 404);

    // --- unauthenticated page navigation redirects to /login; unauthenticated API-style call gets 401 ---
    const anonNav = await fetch(`${base}/s/training/`, { redirect: "manual", headers: { "Sec-Fetch-Dest": "document" } });
    assert.equal(anonNav.status, 302);
    const anonApi = await fetch(`${base}/s/training/`, { headers: { "Sec-Fetch-Dest": "empty" } });
    assert.equal(anonApi.status, 401);

    // --- mission upload, as the site admin (who has upload rights on Training) ---
    const form = new FormData();
    form.append("mission", new Blob([Buffer.from("fake miz bytes")], { type: "application/octet-stream" }), "test-mission.miz");
    const uploadRes = await fetch(`${base}/s/training/missions/upload`, {
      method: "POST",
      headers: { Cookie: siteAdminCookie },
      body: form,
    });
    assert.equal(uploadRes.status, 200);
    const uploadCall = lastAgentCall("POST", "/upload");
    assert.ok(uploadCall, "the upload must reach the agent's /upload endpoint");
    assert.equal(uploadCall.authorization, `Bearer ${AGENT_TOKEN}`, "agent must receive the shared bearer token");
    assert.match(uploadCall.body.toString("latin1"), /training/, "instance_name must be forwarded to the agent");

    // non-.miz upload must be rejected before it ever reaches the agent's
    // /upload endpoint -- the page re-render after the rejection still
    // legitimately calls the agent's list endpoint, so the count of real
    // /upload calls is what has to stay unchanged, not "no agent call at all"
    const uploadCallCountBefore = dummyAgentCalls.filter((c) => c.method === "POST" && c.url === "/upload").length;
    const badForm = new FormData();
    badForm.append("mission", new Blob([Buffer.from("not a mission")], { type: "text/plain" }), "not-a-mission.txt");
    const badUploadRes = await fetch(`${base}/s/training/missions/upload`, {
      method: "POST",
      headers: { Cookie: siteAdminCookie },
      body: badForm,
    });
    assert.equal(badUploadRes.status, 400);
    const uploadCallCountAfter = dummyAgentCalls.filter((c) => c.method === "POST" && c.url === "/upload").length;
    assert.equal(uploadCallCountAfter, uploadCallCountBefore, "rejected file must never be forwarded to the mission agent's /upload endpoint");

    // --- served markup for both admin tables must have valid, submittable forms ---
    const accountsHtml = await (await fetch(`${base}/admin/accounts`, { headers: { Cookie: siteAdminCookie } })).text();
    assertNoBrokenTableForms(accountsHtml, "/admin/accounts");
    const serversHtml = await (await fetch(`${base}/admin/servers`, { headers: { Cookie: siteAdminCookie } })).text();
    assertNoBrokenTableForms(serversHtml, "/admin/servers");
    // site admin has full permissions on Training (granted at bootstrap),
    // so this exercises the download form too -- not just the delete forms
    const trainingMissionsHtml = await (await fetch(`${base}/s/training/missions`, { headers: { Cookie: siteAdminCookie } })).text();
    assertNoBrokenTableForms(trainingMissionsHtml, "/s/training/missions");

    // --- server management: restricted account can't manage servers ---
    const forbiddenServers = await fetch(`${base}/admin/servers`, { headers: { Cookie: serverAdminCookie } });
    assert.equal(forbiddenServers.status, 403);

    // --- site admin creates a new server ---
    const createServerRes = await fetch(`${base}/admin/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: `slug=community2&name=${encodeURIComponent("Example Server - Community 2")}&instance_name=community2`,
    });
    assert.equal(createServerRes.status, 200);
    const newServerRow = db.prepare("SELECT * FROM servers WHERE slug = ?").get("community2");
    assert.ok(newServerRow, "new server must exist in the DB");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM admin_server_access WHERE server_id = ?").get(newServerRow.id).n,
      0,
      "creating a server must not implicitly grant anyone access to it"
    );

    // rejects a bad slug instead of silently accepting it
    const badSlugRes = await fetch(`${base}/admin/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: `slug=${encodeURIComponent("not a slug!")}&name=X&instance_name=x`,
    });
    assert.equal(badSlugRes.status, 400);

    // rejects a duplicate slug
    const dupSlugRes = await fetch(`${base}/admin/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: `slug=community2&name=X&instance_name=x`,
    });
    assert.equal(dupSlugRes.status, 400);

    // rejects an instance name with path-traversal characters
    const badInstanceRes = await fetch(`${base}/admin/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: `slug=community3&name=X&instance_name=${encodeURIComponent("../escape")}`,
    });
    assert.equal(badInstanceRes.status, 400);

    // edit the server
    const editServerRes = await fetch(`${base}/admin/servers/${newServerRow.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: `name=${encodeURIComponent("Renamed Community 2")}&instance_name=community2`,
      redirect: "manual",
    });
    assert.equal(editServerRes.status, 302);
    assert.equal(db.prepare("SELECT name FROM servers WHERE id = ?").get(newServerRow.id).name, "Renamed Community 2");

    // grant the restricted admin access, then delete the server, and confirm the grant cascades away
    serversDb.setAccess(serverAdminRow.id, newServerRow.id, { canUploadMissions: false });
    assert.equal(serversDb.hasServerAccess(serverAdminRow.id, newServerRow.id), true);
    const deleteServerRes = await fetch(`${base}/admin/servers/${newServerRow.id}/delete`, {
      method: "POST",
      headers: { Cookie: siteAdminCookie },
      redirect: "manual",
    });
    assert.equal(deleteServerRes.status, 302);
    assert.equal(db.prepare("SELECT * FROM servers WHERE id = ?").get(newServerRow.id), undefined);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM admin_server_access WHERE server_id = ?").get(newServerRow.id).n,
      0,
      "deleting a server must cascade-delete its access grants"
    );

    // --- last-site-admin delete guard ---
    const soleSiteAdminId = db.prepare("SELECT id FROM admins WHERE username = 'siteadmin'").get().id;
    const deleteSelfRes = await fetch(`${base}/admin/accounts/${soleSiteAdminId}/delete`, {
      method: "POST",
      headers: { Cookie: siteAdminCookie },
      redirect: "manual",
    });
    assert.equal(deleteSelfRes.status, 400, "must refuse to delete the last remaining admin account");

    // --- login rate limiting. A throwaway username on the same running
    // server avoids a second app/db instance -- better-sqlite3's native
    // addon does not tolerate require.cache-driven re-instantiation
    // mid-process. ---
    let lastAttempt;
    for (let i = 0; i < 6; i++) {
      lastAttempt = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "username=rate-limit-probe&password=wrong-password",
      });
    }
    assert.equal(lastAttempt.status, 429, "6th attempt within the window should be rate-limited");

    // --- self-service password change: wrong current password rejected,
    // correct flow updates the hash and signs out every *other* session for
    // that account while leaving the one that made the change alone ---
    const secondServerAdminLogin = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=serveradmin&password=another-long-password",
      redirect: "manual",
    });
    const serverAdminCookie2 = extractCookie(secondServerAdminLogin);
    assert.ok(serverAdminCookie2, "a second concurrent session for the same account must be possible");

    const badCurrentPwRes = await fetch(`${base}/admin/accounts/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: serverAdminCookie },
      body: "current_password=wrong-password&new_password=brand-new-password-1&confirm_password=brand-new-password-1",
    });
    assert.equal(badCurrentPwRes.status, 400, "wrong current password must be rejected");

    const changePwRes = await fetch(`${base}/admin/accounts/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: serverAdminCookie },
      body: "current_password=another-long-password&new_password=brand-new-password-1&confirm_password=brand-new-password-1",
    });
    assert.equal(changePwRes.status, 200);

    // the session that made the change stays alive
    const afterChangeOwnSession = await fetch(`${base}/`, {
      headers: { Cookie: serverAdminCookie, "Sec-Fetch-Dest": "document" },
      redirect: "manual",
    });
    assert.equal(afterChangeOwnSession.status, 200, "the session that changed the password must stay signed in");

    // the other, older session for the same account must have been signed out
    const afterChangeOtherSession = await fetch(`${base}/`, {
      headers: { Cookie: serverAdminCookie2, "Sec-Fetch-Dest": "document" },
      redirect: "manual",
    });
    assert.equal(afterChangeOtherSession.status, 302, "changing the password must sign out every other session for that account");

    // --- invite-based account creation ---
    const createInviteRes = await fetch(`${base}/admin/accounts/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: "",
    });
    assert.equal(createInviteRes.status, 200);
    const createInviteHtml = await createInviteRes.text();
    const inviteLinkMatch = createInviteHtml.match(/\/invite\/([0-9a-f]{64})/);
    assert.ok(inviteLinkMatch, "creating an invite must display the full invite link");
    const inviteToken = inviteLinkMatch[1];
    const inviteRow = db.prepare("SELECT * FROM invites WHERE token_prefix = ?").get(inviteToken.slice(0, 6));
    assert.ok(inviteRow, "invite must be persisted");

    // pending invite shows up in the accounts table like a real user, with
    // its own Permissions popup button, a Save button, and a Revoke button
    const accountsWithInviteHtml = await (
      await fetch(`${base}/admin/accounts`, { headers: { Cookie: siteAdminCookie } })
    ).text();
    assert.match(accountsWithInviteHtml, new RegExp(`${inviteToken.slice(0, 6)}.*\\(pending, expires`));
    assert.match(accountsWithInviteHtml, new RegExp(`formaction="/admin/accounts/invites/${inviteRow.id}/revoke" class="destructive"`));
    assert.match(accountsWithInviteHtml, /data-kind="invite"/, "a pending invite's row must render the same Permissions popup button");

    // Save updates the pending invite's can_manage_accounts flag; granting
    // a server permission is now its own popup-endpoint call, same as for
    // a real account
    const saveInviteRes = await fetch(`${base}/admin/accounts/invites/${inviteRow.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: "can_manage_accounts=on",
      redirect: "manual",
    });
    assert.equal(saveInviteRes.status, 302);
    assert.equal(db.prepare("SELECT can_manage_accounts FROM invites WHERE id = ?").get(inviteRow.id).can_manage_accounts, 1);

    const grantInviteViewRes = await fetch(`${base}/admin/accounts/invites/${inviteRow.id}/permissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: siteAdminCookie },
      body: JSON.stringify({ server_id: trainingServerId, permission: "view", granted: true }),
    });
    assert.equal(grantInviteViewRes.status, 200);
    const inviteGrant = invitesDb.getInviteAccess(inviteRow.id).find((g) => g.server_id === trainingServerId);
    assert.ok(inviteGrant && inviteGrant.can_view_missions, "the invite-permissions endpoint must persist the grant");

    // Revoke deletes it outright
    const revokeInviteRes = await fetch(`${base}/admin/accounts/invites/${inviteRow.id}/revoke`, {
      method: "POST",
      headers: { Cookie: siteAdminCookie },
      redirect: "manual",
    });
    assert.equal(revokeInviteRes.status, 302);
    assert.equal(db.prepare("SELECT * FROM invites WHERE id = ?").get(inviteRow.id), undefined);

    // a non-site-admin must not be able to create or revoke invites
    const forbiddenInviteCreate = await fetch(`${base}/admin/accounts/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: serverAdminCookie },
      body: "",
    });
    assert.equal(forbiddenInviteCreate.status, 403);

    // --- invite redemption: the invitee picks their own username/password,
    // permissions come from what the invite already had set via the
    // permissions-popup endpoint ---
    const redeemInviteRes = await fetch(`${base}/admin/accounts/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: "",
    });
    const redeemToken = (await redeemInviteRes.text()).match(/\/invite\/([0-9a-f]{64})/)[1];
    const redeemInviteId = db.prepare("SELECT id FROM invites WHERE token_prefix = ?").get(redeemToken.slice(0, 6)).id;
    for (const permission of ["access", "upload"]) {
      const grantRes = await fetch(`${base}/admin/accounts/invites/${redeemInviteId}/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: siteAdminCookie },
        body: JSON.stringify({ server_id: trainingServerId, permission, granted: true }),
      });
      assert.equal(grantRes.status, 200);
    }

    const inviteLandingRes = await fetch(`${base}/invite/${redeemToken}`);
    assert.equal(inviteLandingRes.status, 200);
    assert.match(await inviteLandingRes.text(), /Create your account/);

    const redeemPostRes = await fetch(`${base}/invite/${redeemToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=invitee&password=invitee-long-password&confirm_password=invitee-long-password",
      redirect: "manual",
    });
    assert.equal(redeemPostRes.status, 302, "redeeming a valid invite must create the account and sign it in");
    const inviteeCookie = extractCookie(redeemPostRes);
    assert.ok(inviteeCookie);

    const inviteeRow = db.prepare("SELECT * FROM admins WHERE username = 'invitee'").get();
    assert.ok(inviteeRow, "redeeming the invite must create the admin account");
    assert.equal(inviteeRow.can_manage_accounts, 0);
    assert.equal(
      serversDb.hasServerAccess(inviteeRow.id, trainingServerId),
      true,
      "the new account must get exactly the access the invite was created with"
    );
    assert.equal(
      serversDb.hasPermission(inviteeRow.id, trainingServerId, "upload"),
      true,
      "redeemed account must carry over the upload grant the invite had"
    );
    assert.equal(
      serversDb.hasPermission(inviteeRow.id, trainingServerId, "view"),
      false,
      "redeemed account must not carry over a permission the invite never had"
    );
    assert.equal(db.prepare("SELECT * FROM invites WHERE id = ?").get(redeemInviteId), undefined, "a redeemed invite must be consumed (deleted)");

    // the token is single-use: redeeming it again must fail
    const reuseTokenRes = await fetch(`${base}/invite/${redeemToken}`);
    assert.equal(reuseTokenRes.status, 404, "a consumed invite token must not be redeemable again");

    // an unknown/expired token also 404s with the expired-invite page
    const bogusTokenRes = await fetch(`${base}/invite/${"0".repeat(64)}`);
    assert.equal(bogusTokenRes.status, 404);
    assert.match(await bogusTokenRes.text(), /invalid or has expired/);

    // --- A/B self-update page: site-admin only, sidebar icon tracks
    // whether update_state actually has an available version ---
    const forbiddenUpdatePage = await fetch(`${base}/admin/update`, { headers: { Cookie: serverAdminCookie } });
    assert.equal(forbiddenUpdatePage.status, 403, "a non-site-admin must not reach the update page");

    const dashBeforeUpdate = await (await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.doesNotMatch(dashBeforeUpdate, /icon-update\.svg/, "no update icon when update_state has no available version");

    const updatePageRes = await fetch(`${base}/admin/update`, { headers: { Cookie: siteAdminCookie } });
    assert.equal(updatePageRes.status, 200);
    assert.match(await updatePageRes.text(), /latest version/i);

    db.prepare("UPDATE update_state SET available_version = ?, changelog_url = ? WHERE id = 1").run("9.9.9", "https://example.test/changelog");
    const dashAfterUpdate = await (await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.match(dashAfterUpdate, /icon-update\.svg/, "sidebar icon must appear once update_state has an available version");
    assert.match(dashAfterUpdate, /href="\/admin\/update"/);

    const updatePageWithUpdateHtml = await (await fetch(`${base}/admin/update`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.match(updatePageWithUpdateHtml, /9\.9\.9/);
    assert.match(updatePageWithUpdateHtml, /Update now/);

    db.prepare("UPDATE update_state SET available_version = NULL, changelog_url = NULL WHERE id = 1").run();

    // --- logout is a destructive-styled navbar button, POST only ---
    const dashboardHtmlForLogout = await (await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.match(dashboardHtmlForLogout, /<form method="post" action="\/logout" class="logout-form">/);
    assert.match(dashboardHtmlForLogout, /<button type="submit" class="destructive">Sign out<\/button>/);
    const getLogoutRes = await fetch(`${base}/logout`, { headers: { Cookie: siteAdminCookie }, redirect: "manual" });
    assert.equal(getLogoutRes.status, 404, "logout must only accept POST now, not the old GET link");

    // --- logout actually invalidates the session ---
    await fetch(`${base}/logout`, { method: "POST", headers: { Cookie: siteAdminCookie }, redirect: "manual" });
    const afterLogout = await fetch(`${base}/`, {
      headers: { Cookie: siteAdminCookie, "Sec-Fetch-Dest": "document" },
      redirect: "manual",
    });
    assert.equal(afterLogout.status, 302, "session must be dead after logout");
  } finally {
    server.close();
  }
});
