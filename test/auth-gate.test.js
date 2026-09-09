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

let app, db, serversDb, serverProxy;
let dummyAgent, dummyAgentPort;
let dummyAgentReceived;
let sqlitePath;
const AGENT_TOKEN = "test-agent-token";

test.before(async () => {
  dummyAgent = await startDummyHttpServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      dummyAgentReceived = {
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks),
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  dummyAgentPort = dummyAgent.address().port;

  sqlitePath = tempSqlitePath("main");
  process.env.SQLITE_PATH = sqlitePath;
  process.env.COOKIE_SECURE = "false"; // plain http in tests, no TLS
  process.env.MISSION_AGENT_URL = `http://127.0.0.1:${dummyAgentPort}`;
  process.env.MISSION_AGENT_TOKEN = AGENT_TOKEN;

  app = require("../src/server");
  db = require("../src/db");
  serversDb = require("../src/servers");
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

    // --- create a second admin, granted access to Training only, no upload, no account mgmt ---
    const trainingServerId = db.prepare("SELECT id FROM servers WHERE slug = ?").get("training").id;
    const createRes = await fetch(`${base}/admin/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: `username=serveradmin&password=another-long-password&access_${trainingServerId}=on`,
      redirect: "manual",
    });
    assert.equal(createRes.status, 302);

    const serverAdminRow = db.prepare("SELECT * FROM admins WHERE username = ?").get("serveradmin");
    assert.equal(serverAdminRow.can_manage_accounts, 0, "new account must not default to site-admin");

    // --- the accounts page must render checkbox state that matches what was
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
    assert.match(
      serveradminRowHtml,
      new RegExp(`name="access_${trainingServerId}"[^>]*checked`),
      "granted access must render as a checked checkbox, not reset on page load"
    );
    assert.doesNotMatch(
      serveradminRowHtml,
      new RegExp(`name="upload_${trainingServerId}"[^>]*checked`),
      "upload was never granted, so that checkbox must render unchecked"
    );

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

    // restricted account must not reach account management
    const forbiddenAccounts = await fetch(`${base}/admin/accounts`, { headers: { Cookie: serverAdminCookie } });
    assert.equal(forbiddenAccounts.status, 403);

    // restricted account must not reach Community 1's proxy
    const forbiddenProxy = await fetch(`${base}/s/community1/`, { headers: { Cookie: serverAdminCookie } });
    assert.equal(forbiddenProxy.status, 403);

    // restricted account has access but not upload rights on Training
    const forbiddenUpload = await fetch(`${base}/s/training/missions`, { headers: { Cookie: serverAdminCookie } });
    assert.equal(forbiddenUpload.status, 403, "access without the upload flag must not reach the missions page");

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
    assert.equal(dummyAgentReceived.authorization, `Bearer ${AGENT_TOKEN}`, "agent must receive the shared bearer token");
    assert.match(dummyAgentReceived.body.toString("latin1"), /training/, "instance_name must be forwarded to the agent");

    // non-.miz upload must be rejected before it ever reaches the agent
    dummyAgentReceived = null;
    const badForm = new FormData();
    badForm.append("mission", new Blob([Buffer.from("not a mission")], { type: "text/plain" }), "not-a-mission.txt");
    const badUploadRes = await fetch(`${base}/s/training/missions/upload`, {
      method: "POST",
      headers: { Cookie: siteAdminCookie },
      body: badForm,
    });
    assert.equal(badUploadRes.status, 400);
    assert.equal(dummyAgentReceived, null, "rejected file must never be forwarded to the mission agent");

    // --- served markup for both admin tables must have valid, submittable forms ---
    const accountsHtml = await (await fetch(`${base}/admin/accounts`, { headers: { Cookie: siteAdminCookie } })).text();
    assertNoBrokenTableForms(accountsHtml, "/admin/accounts");
    const serversHtml = await (await fetch(`${base}/admin/servers`, { headers: { Cookie: siteAdminCookie } })).text();
    assertNoBrokenTableForms(serversHtml, "/admin/servers");

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

    // --- logout actually invalidates the session ---
    await fetch(`${base}/logout`, { headers: { Cookie: siteAdminCookie }, redirect: "manual" });
    const afterLogout = await fetch(`${base}/`, {
      headers: { Cookie: siteAdminCookie, "Sec-Fetch-Dest": "document" },
      redirect: "manual",
    });
    assert.equal(afterLogout.status, 302, "session must be dead after logout");
  } finally {
    server.close();
  }
});
