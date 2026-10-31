const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const vm = require("node:vm");

// a minimal http server, standing in for a real dummy backend
function startDummyHttpServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// checks served markup for the out-of-band row-form pattern
// see docs/Why.md#why-does-assertnobrokentableforms-exist
function assertNoBrokenTableForms(html, context) {
  assert.doesNotMatch(html, /<tr>\s*<form/i, `${context}: a <form> must not be nested directly inside a <tr>`);
  const formIds = new Set([...html.matchAll(/<form[^>]*\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const match of html.matchAll(/\bform="([^"]+)"/g)) {
    assert.ok(formIds.has(match[1]), `${context}: an input references form="${match[1]}" but no <form id="${match[1]}"> exists`);
  }
  // an empty out-of-band form needs class="row-form", see style.css,
  // or the plain `form { ... }` rule renders it as a visible blank box
  for (const match of html.matchAll(/<form\s+id="[^"]+"[^>]*><\/form>/g)) {
    assert.match(match[0], /class="row-form"/, `${context}: an empty out-of-band form must carry class="row-form" or it renders as a visible blank box: ${match[0]}`);
  }
}

// pull just the cookie's own name=value out of a set-cookie header
function extractCookie(res) {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  return setCookie.split(";")[0];
}

// node's fetch() has no cookie jar, so a redirect's flash cookie never
// reaches the request it auto-follows, capture it and refetch by hand
async function postAndFollowFlash(url, options) {
  const res = await fetch(url, { ...options, redirect: "manual" });
  assert.equal(res.status, 302, `expected a redirect (PRG) from ${url}, got ${res.status}`);
  const flashCookie = extractCookie(res);
  const location = res.headers.get("location");
  const cookieHeader = [options.headers?.Cookie, flashCookie].filter(Boolean).join("; ");
  return fetch(new URL(location, url), { headers: { Cookie: cookieHeader } });
}

// a fresh, unique sqlite path per test file, under the os temp dir
function tempSqlitePath(label) {
  return path.join(os.tmpdir(), `auth-gate-test-${label}-${crypto.randomBytes(6).toString("hex")}.sqlite`);
}

// delete a sqlite file and its wal/shm siblings
function cleanupSqlite(sqlitePath) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(sqlitePath + suffix, { force: true });
}

let app, db, updateCheck, serversDb, invitesDb, serverProxy, auth;
let dummyAgent, dummyAgentPort;
// a page render can make more than one agent call (e.g. an upload post
// then a list get), so every call is kept, not just the last one
let dummyAgentCalls;
// find a specific agent call by method and path, regardless of what
// else the app also happened to call afterward
function lastAgentCall(method, pathPrefix) {
  return dummyAgentCalls.filter((c) => c.method === method && c.url.startsWith(pathPrefix)).pop();
}
let sqlitePath;
let authGateLogPath;
const AGENT_TOKEN = "test-agent-token";

// controls dummyAgent's get /logs response, set per test
let dummyAgentLogText = "";
let dummyAgentLogsShouldFail = false;

// stands in for the real github api updateCheck.js's checkForUpdate()
// reaches, set per test via dummyGithubRespond
let dummyGithub, dummyGithubBase;
let dummyGithubRespond = (req, res) => {
  res.writeHead(500);
  res.end("dummyGithubRespond not set for this test");
};

test.before(async () => {
  dummyAgent = await startDummyHttpServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      dummyAgentCalls.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks) });
      if (req.method === "GET" && req.url === "/logs") {
        if (dummyAgentLogsShouldFail) {
          res.writeHead(502, { "Content-Type": "text/plain" });
          return res.end("simulated agent log failure");
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end(dummyAgentLogText);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      // a list get needs a real { missions: [...] } shape, not the
      // generic { ok: true } every other stubbed endpoint returns
      res.end(req.method === "GET" && req.url.startsWith("/missions/") ? JSON.stringify({ missions: [] }) : JSON.stringify({ ok: true }));
    });
  });
  dummyAgentPort = dummyAgent.address().port;
  dummyAgentCalls = [];

  dummyGithub = await startDummyHttpServer((req, res) => dummyGithubRespond(req, res));
  dummyGithubBase = `http://127.0.0.1:${dummyGithub.address().port}`;

  sqlitePath = tempSqlitePath("main");
  process.env.SQLITE_PATH = sqlitePath;
  process.env.COOKIE_SECURE = "false"; // plain http in tests, no TLS
  process.env.MISSION_AGENT_URL = `http://127.0.0.1:${dummyAgentPort}`;
  process.env.MISSION_AGENT_TOKEN = AGENT_TOKEN;
  process.env.GITHUB_API_BASE_OVERRIDE = dummyGithubBase;
  authGateLogPath = path.join(os.tmpdir(), `auth-gate-test-log-${crypto.randomBytes(6).toString("hex")}.log`);
  process.env.AUTH_GATE_LOG_PATH = authGateLogPath;

  app = require("../src/server");
  db = require("../src/db");
  updateCheck = require("../src/updateCheck");
  serversDb = require("../src/servers");
  invitesDb = require("../src/invites");
  serverProxy = require("../src/serverProxy");
  auth = require("../src/auth");
});

test.after(async () => {
  await new Promise((resolve) => dummyAgent.close(resolve));
  await new Promise((resolve) => dummyGithub.close(resolve));
  db.close();
  cleanupSqlite(sqlitePath);
  for (const suffix of ["", ".1"]) fs.rmSync(authGateLogPath + suffix, { force: true });
});

test("full flow: setup, login, dashboard filtering, accounts, proxy, missions, logout", async (t) => {
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
    // /setup creates the first admin with full access
    const setupRes = await fetch(`${base}/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=siteadmin&password=correct-horse-battery-staple",
      redirect: "manual",
    });
    assert.equal(setupRes.status, 302, "setup should redirect after creating the first admin");
    const siteAdminCookie = extractCookie(setupRes);
    assert.ok(siteAdminCookie, "setup should set a session cookie");

    // /setup is a one-time door, must 404 now that an admin exists
    const setupAgainRes = await fetch(`${base}/setup`);
    assert.equal(setupAgainRes.status, 404, "/setup must 404 once an admin account exists");

    // dashboard shows the site admin's (full) access
    const dashRes = await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } });
    const dashHtml = await dashRes.text();
    assert.match(dashHtml, /Example Server - Training/);
    assert.match(dashHtml, /Example Server - Community 1/);

    // a malformed dcs_flash cookie (null, a number, a quoted string, an
    // array) must never crash the process, just render with no flash
    for (const malformed of ["null", "1", '"x"', "[]"]) {
      for (const flashPath of ["/login", "/admin/accounts", "/s/training/missions"]) {
        const cookie = `${siteAdminCookie}; dcs_flash=${malformed}`;
        const res = await fetch(`${base}${flashPath}`, { headers: { Cookie: cookie } });
        assert.notEqual(res.status, 500, `dcs_flash=${malformed} on ${flashPath} must not 500`);
      }
    }
    const stillAliveRes = await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } });
    assert.equal(stillAliveRes.status, 200, "the server must still answer after every malformed flash cookie");

    // create a second admin with no permissions yet, no account mgmt
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

    // grant access + view (not upload) on training, one permission
    // per call, exactly how a cell click in the popup behaves
    for (const permission of ["access", "view"]) {
      const grantRes = await fetch(`${base}/admin/accounts/${serverAdminRow.id}/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: siteAdminCookie },
        body: JSON.stringify({ server_id: trainingServerId, permission, granted: true }),
      });
      assert.equal(grantRes.status, 200);
    }

    // the accounts page must render popup state matching what was
    // granted, regression check for getAccessibleServers()'s server_id gotcha
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

    // a server named with an html sink must render escaped in the perm
    // popup's own inline script, actually run against a stub dom, not
    // just checked for presence in the raw markup
    const xssServerName = "<img src=x onerror=alert(1)>";
    db.prepare("INSERT INTO servers (slug, name, instance_name) VALUES (?, ?, ?)").run("xss-server", xssServerName, "Example_Xss");
    const accountsHtmlWithXssServer = await (
      await fetch(`${base}/admin/accounts`, { headers: { Cookie: siteAdminCookie } })
    ).text();
    const permPopupScriptMatch = accountsHtmlWithXssServer.match(/<div id="perm-popup"[^>]*><\/div>\s*<script>([\s\S]*?)<\/script>/);
    assert.ok(permPopupScriptMatch, "accounts page must render the perm-popup's own inline script");

    let capturedPopupInnerHtml = "";
    let permBtnClickHandler;
    const popupStub = {
      style: {},
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
      querySelector: (sel) => (sel === ".perm-close" ? { addEventListener: () => {} } : null),
      querySelectorAll: () => [],
      contains: () => false,
      set innerHTML(value) {
        capturedPopupInnerHtml = value;
      },
    };
    const permBtnStub = {
      getAttribute: (attr) => ({ "data-kind": "account", "data-id": "999", "data-access": "[]" })[attr],
      addEventListener: (type, handler) => {
        if (type === "click") permBtnClickHandler = handler;
      },
    };
    const permPopupContext = {
      document: {
        getElementById: (id) => (id === "perm-popup" ? popupStub : null),
        querySelectorAll: (sel) => (sel === ".perm-btn" ? [permBtnStub] : []),
        addEventListener: () => {},
      },
      window: { innerWidth: 1000, innerHeight: 800 },
    };
    vm.createContext(permPopupContext);
    vm.runInContext(permPopupScriptMatch[1], permPopupContext);
    assert.ok(permBtnClickHandler, "the popup script must attach a click handler to every .perm-btn");
    permBtnClickHandler({ clientX: 0, clientY: 0, stopPropagation: () => {} });

    assert.doesNotMatch(capturedPopupInnerHtml, /<img/, "a server name must never reach popup.innerHTML as a live html sink");
    assert.match(capturedPopupInnerHtml, /&lt;img src=x onerror=alert\(1\)&gt;/, "the server name must render escaped instead");

    // crash safety net: an error thrown inside an async handler must
    // return 500, not take the whole process down with it
    // see docs/Why.md#why-does-every-async-handler-need-asynchandler
    const verifyPasswordMock = t.mock.method(auth, "verifyPassword", () => {
      throw new Error("simulated crash inside an async handler");
    });
    const crashRes = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=serveradmin&password=another-long-password",
      redirect: "manual",
    });
    assert.equal(crashRes.status, 500, "a thrown error inside an async handler must return 500, not crash the process");
    verifyPasswordMock.mock.restore();

    const loginRes = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=serveradmin&password=another-long-password",
      redirect: "manual",
    });
    assert.equal(loginRes.status, 302, "the next request after a caught crash must still succeed, the process must still be alive");
    const serverAdminCookie = extractCookie(loginRes);
    assert.ok(serverAdminCookie);

    // dashboard should show only training, not community 1
    const restrictedDash = await fetch(`${base}/`, { headers: { Cookie: serverAdminCookie } });
    const restrictedHtml = await restrictedDash.text();
    assert.match(restrictedHtml, /Example Server - Training/);
    assert.doesNotMatch(restrictedHtml, /Example Server - Community 1/);

    // restricted account gets the read-only my-account page, not a 403,
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
    // missions page (gated on "any-mission", not "access") must 403 there too
    const forbiddenMissionsNoAccess = await fetch(`${base}/s/community1/missions`, { headers: { Cookie: serverAdminCookie } });
    assert.equal(forbiddenMissionsNoAccess.status, 403);

    // on training it has view but not upload, the missions page is
    // reachable but shows no upload form
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

    // a permission the matrix lets a site admin grant alone (upload,
    // or download) must still have somewhere to be used
    // see docs/Why.md#why-does-any-mission-exist-alongside-view
    async function loginAs(username, password) {
      const res = await fetch(`${base}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `username=${username}&password=${encodeURIComponent(password)}`,
        redirect: "manual",
      });
      const cookie = extractCookie(res);
      assert.ok(cookie, `login as ${username} must succeed`);
      return cookie;
    }

    const uploadOnlyId = db
      .prepare("INSERT INTO admins (username, password_hash) VALUES (?, ?)")
      .run("uploadonlyadmin", auth.hashPassword("upload-only-long-password")).lastInsertRowid;
    serversDb.setAccess(uploadOnlyId, trainingServerId, { canUploadMissions: true });
    const uploadOnlyCookie = await loginAs("uploadonlyadmin", "upload-only-long-password");
    const uploadOnlyRes = await fetch(`${base}/s/training/missions`, { headers: { Cookie: uploadOnlyCookie } });
    assert.equal(uploadOnlyRes.status, 200, "upload-only access must be enough to reach the missions page");
    const uploadOnlyHtml = await uploadOnlyRes.text();
    assert.match(uploadOnlyHtml, /Upload mission/, "upload rights must show the upload form");
    assert.doesNotMatch(uploadOnlyHtml, /<h2>Missions<\/h2>/, "no view, download, or delete rights means no mission list");

    const downloadOnlyId = db
      .prepare("INSERT INTO admins (username, password_hash) VALUES (?, ?)")
      .run("downloadonlyadmin", auth.hashPassword("download-only-long-password")).lastInsertRowid;
    serversDb.setAccess(downloadOnlyId, trainingServerId, { canDownloadMissions: true });
    const downloadOnlyCookie = await loginAs("downloadonlyadmin", "download-only-long-password");
    const downloadOnlyRes = await fetch(`${base}/s/training/missions`, { headers: { Cookie: downloadOnlyCookie } });
    assert.equal(downloadOnlyRes.status, 200, "download-only access must be enough to reach the missions page");
    const downloadOnlyHtml = await downloadOnlyRes.text();
    assert.doesNotMatch(downloadOnlyHtml, /Upload mission/, "no upload rights means no upload form");
    assert.match(downloadOnlyHtml, /<h2>Missions<\/h2>/, "download rights alone must still show the list to pick a mission from");
    assert.match(downloadOnlyHtml, /Download selected/, "download rights must show the download button");

    // the real webgui's own static bundle is served under /s/<slug>/
    const webguiRes = await fetch(`${base}/s/training/`, { headers: { Cookie: siteAdminCookie } });
    assert.equal(webguiRes.status, 200);
    const webguiHtml = await webguiRes.text();
    assert.match(webguiHtml, /<div id="app">/, "must serve the real webgui's index.html, not a proxied response");

    // the control-port token bootstrap must be injected with a fresh
    // token each load, nothing else lets the spa's fetch() reach the proxy
    const tokenMatch = webguiHtml.match(/var TOKEN = "([0-9a-f]+)"/);
    assert.ok(tokenMatch, "index.html response must include the control-port token bootstrap script");
    const webguiRes2 = await fetch(`${base}/s/training/`, { headers: { Cookie: siteAdminCookie } });
    const tokenMatch2 = (await webguiRes2.text()).match(/var TOKEN = "([0-9a-f]+)"/);
    assert.notEqual(tokenMatch2[1], tokenMatch[1], "each page load must mint its own distinct token");

    // the bootstrap's fetch-rewrite logic, actually executed, not just
    // checked for presence, see docs/Why.md#why-does-this-test-run-the-bootstrap-with-vm
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
        addEventListener: () => {},
      };
      // the back-button iife also runs here and needs a document, with
      // no real navbar-brand it falls into the mutationobserver branch
      // and just has to not throw, irrelevant to what this helper checks
      context.document = {
        getElementById: () => null,
        createElement: () => ({ style: {} }),
        head: { appendChild: () => {} },
        querySelector: () => null,
        documentElement: {},
      };
      context.MutationObserver = class {
        observe() {}
        disconnect() {}
      };
      vm.createContext(context);
      vm.runInContext(bootstrapScript, context);
      context.window.fetch(requestUrl);
      return calls[0];
    }

    const hostname = "panel.example.test";
    const pathname = "/s/training/";

    // the real dcs webgui's own malformed default backend url, byte
    // for byte, see docs/Why.md#why-does-the-backend-url-rewrite-undo-a-literal-backslash
    const rewritten = runBootstrapFetch("http://127.0.0.1\\:8088/encryptedRequest", { hostname, pathname });
    assert.equal(
      rewritten,
      `https://${hostname}:${serverProxy.CONTROL_PORT}/encryptedRequest`,
      "must rewrite the real DCS webgui's malformed default backend URL to a clean same-host URL with no doubled port"
    );

    // a request for the app's own served files, under base_path,
    // must pass through untouched, not get sent at the control-port proxy
    const ownAsset = runBootstrapFetch(`${pathname}js/app.js`, { hostname, pathname });
    assert.equal(ownAsset, `${pathname}js/app.js`, "a request for the app's own served files must not be rewritten");

    // the same bootstrap also injects a back-to-control-panel button,
    // actually run against a stub dom exposing one, not just checked
    // for presence the way the fetch-rewrite logic above is
    {
      const headChildren = [];
      const navbarChildren = [];
      const navbarEl = {
        appendChild: (el) => navbarChildren.push(el),
        getBoundingClientRect: () => ({ left: 0 }),
      };
      const brandEl = {
        closest: (sel) => (sel === ".navbar" ? navbarEl : null),
        getBoundingClientRect: () => ({ right: 180 }),
      };
      const context2 = {
        document: {
          getElementById: () => null,
          createElement: () => ({ style: {} }),
          head: { appendChild: (el) => headChildren.push(el) },
          querySelector: (sel) => (sel === ".navbar-brand" ? brandEl : null),
          documentElement: {},
        },
        window: { addEventListener: () => {} },
      };
      vm.createContext(context2);
      vm.runInContext(bootstrapScript, context2);

      assert.equal(navbarChildren.length, 1, "exactly one button must be appended into the navbar");
      const btn = navbarChildren[0];
      assert.equal(btn.href, "/", "the button must link back to the dashboard");
      assert.equal(btn.textContent, "← Control Panel", "the button's label must match the dashboard's own wording");
      assert.equal(btn.style.left, "188px", "left offset must be the brand's measured right edge, relative to the navbar, plus an 8px gap");
      assert.equal(headChildren.length, 1, "the hover-style <style> tag must be injected once");
      assert.match(headChildren[0].textContent, /auth-gate-back-btn:hover/);
    }

    // a path with no matching static asset must 404, not fall through to some proxy
    const missingAssetRes = await fetch(`${base}/s/training/does/not/exist.js`, { headers: { Cookie: siteAdminCookie } });
    assert.equal(missingAssetRes.status, 404);

    // unauthenticated page navigation redirects to /login, api-style call gets 401
    const anonNav = await fetch(`${base}/s/training/`, { redirect: "manual", headers: { "Sec-Fetch-Dest": "document" } });
    assert.equal(anonNav.status, 302);
    const anonApi = await fetch(`${base}/s/training/`, { headers: { "Sec-Fetch-Dest": "empty" } });
    assert.equal(anonApi.status, 401);

    // mission upload, as the site admin (who has upload rights on training)
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

    // the page re-render after rejection still legitimately calls the
    // agent's list endpoint, so only the /upload call count must stay flat
    const uploadCallCountBefore = dummyAgentCalls.filter((c) => c.method === "POST" && c.url === "/upload").length;
    const badForm = new FormData();
    badForm.append("mission", new Blob([Buffer.from("not a mission")], { type: "text/plain" }), "not-a-mission.txt");
    const badUploadRes = await postAndFollowFlash(`${base}/s/training/missions/upload`, {
      method: "POST",
      headers: { Cookie: siteAdminCookie },
      body: badForm,
    });
    assert.match(await badUploadRes.text(), /No \.miz file provided/);
    const uploadCallCountAfter = dummyAgentCalls.filter((c) => c.method === "POST" && c.url === "/upload").length;
    assert.equal(uploadCallCountAfter, uploadCallCountBefore, "rejected file must never be forwarded to the mission agent's /upload endpoint");

    // served markup for both admin tables must have valid, submittable forms
    const accountsHtml = await (await fetch(`${base}/admin/accounts`, { headers: { Cookie: siteAdminCookie } })).text();
    assertNoBrokenTableForms(accountsHtml, "/admin/accounts");
    const serversHtml = await (await fetch(`${base}/admin/servers`, { headers: { Cookie: siteAdminCookie } })).text();
    assertNoBrokenTableForms(serversHtml, "/admin/servers");
    // site admin has full permissions on training, so this exercises
    // the download form too, not just the delete forms
    const trainingMissionsHtml = await (await fetch(`${base}/s/training/missions`, { headers: { Cookie: siteAdminCookie } })).text();
    assertNoBrokenTableForms(trainingMissionsHtml, "/s/training/missions");

    // server management: restricted account can't manage servers
    const forbiddenServers = await fetch(`${base}/admin/servers`, { headers: { Cookie: serverAdminCookie } });
    assert.equal(forbiddenServers.status, 403);

    // site admin creates a new server
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
    const badSlugRes = await postAndFollowFlash(`${base}/admin/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: `slug=${encodeURIComponent("not a slug!")}&name=X&instance_name=x`,
    });
    assert.match(await badSlugRes.text(), /Slug must be lowercase letters/);

    // rejects a duplicate slug
    const dupSlugRes = await postAndFollowFlash(`${base}/admin/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: `slug=community2&name=X&instance_name=x`,
    });
    assert.match(await dupSlugRes.text(), /That slug is already in use/);

    // rejects an instance name with path-traversal characters
    const badInstanceRes = await postAndFollowFlash(`${base}/admin/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: `slug=community3&name=X&instance_name=${encodeURIComponent("../escape")}`,
    });
    assert.match(await badInstanceRes.text(), /DCS instance name must be letters, numbers, underscores, and hyphens only/);

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

    // last-site-admin delete guard
    const soleSiteAdminId = db.prepare("SELECT id FROM admins WHERE username = 'siteadmin'").get().id;
    const deleteSelfRes = await postAndFollowFlash(`${base}/admin/accounts/${soleSiteAdminId}/delete`, {
      method: "POST",
      headers: { Cookie: siteAdminCookie },
    });
    assert.match(await deleteSelfRes.text(), /Can.{1,6}t delete the last site admin.{1,6}s account/, "must refuse to delete the last remaining admin account");

    // login rate limiting, a throwaway username avoids a second app/db
    // instance, better-sqlite3's native addon dislikes that mid-process
    let lastAttempt;
    for (let i = 0; i < 6; i++) {
      lastAttempt = await postAndFollowFlash(`${base}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "username=rate-limit-probe&password=wrong-password",
      });
    }
    assert.match(await lastAttempt.text(), /Too many attempts/, "6th attempt within the window should be rate-limited");

    // login lockout must not count successful logins, and must clear on a
    // success, isolated via a fresh X-Forwarded-For from the blocks above
    const lockoutProbeHeaders = { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "10.1.1.1" };
    for (let i = 0; i < 4; i++) {
      await postAndFollowFlash(`${base}/login`, {
        method: "POST",
        headers: lockoutProbeHeaders,
        body: "username=serveradmin&password=wrong-password",
      });
    }
    // the 5th attempt, with the right password, must still succeed
    // (count was 4, under the limit) and must clear the counter
    const successAfterFourFailuresRes = await fetch(`${base}/login`, {
      method: "POST",
      headers: lockoutProbeHeaders,
      body: "username=serveradmin&password=another-long-password",
      redirect: "manual",
    });
    assert.equal(successAfterFourFailuresRes.status, 302, "a correct password on the 5th attempt must still succeed");
    assert.equal(successAfterFourFailuresRes.headers.get("location"), "/", "a successful login must redirect to the dashboard, not back to /login");

    // a 6th attempt (another failure) must not be locked out, proving
    // the prior success actually cleared the counter
    const afterClearRes = await postAndFollowFlash(`${base}/login`, {
      method: "POST",
      headers: lockoutProbeHeaders,
      body: "username=serveradmin&password=wrong-password",
    });
    assert.match(await afterClearRes.text(), /Invalid username or password/, "a success must clear the counter, so the next attempt is judged on its own, not rejected as rate-limited");

    // six correct logins in a row must all succeed, proving a run of
    // successes alone never trips the lockout
    const successiveLoginHeaders = { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "10.1.1.2" };
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${base}/login`, {
        method: "POST",
        headers: successiveLoginHeaders,
        body: "username=serveradmin&password=another-long-password",
        redirect: "manual",
      });
      assert.equal(res.status, 302, `successive login ${i + 1} of 6 must succeed`);
      assert.equal(res.headers.get("location"), "/", `successive login ${i + 1} of 6 must redirect to the dashboard, not back to /login`);
    }

    // an expired session row must be gone after the next login, not
    // just ignored by getSessionAdmin
    const expiredTokenHash = auth.hashToken("expired-test-token");
    db.prepare(
      `INSERT INTO sessions (admin_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '-1 seconds'))`
    ).run(soleSiteAdminId, expiredTokenHash);
    await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "10.1.1.3" },
      body: "username=serveradmin&password=another-long-password",
      redirect: "manual",
    });
    assert.equal(
      db.prepare("SELECT 1 FROM sessions WHERE token_hash = ?").get(expiredTokenHash),
      undefined,
      "an expired session row must be pruned by the next login"
    );

    // known-username and unknown-username logins must take roughly the
    // same, measurably non-trivial time, as a loose bound since CI
    // hardware varies
    async function timeLogin(usernameForTiming, xff) {
      const t0 = process.hrtime.bigint();
      await fetch(`${base}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": xff },
        body: `username=${encodeURIComponent(usernameForTiming)}&password=wrong-password`,
        redirect: "manual",
      });
      return Number(process.hrtime.bigint() - t0) / 1e6;
    }
    const knownUsernameMs = await timeLogin("serveradmin", "10.1.1.4");
    const unknownUsernameMs = await timeLogin("no-such-admin", "10.1.1.5");
    assert.ok(knownUsernameMs > 20, `a known-username login must take a measurably non-trivial time, took ${knownUsernameMs}ms`);
    assert.ok(unknownUsernameMs > 20, `an unknown-username login must take a measurably non-trivial time, took ${unknownUsernameMs}ms`);
    const [fasterMs, slowerMs] = [knownUsernameMs, unknownUsernameMs].sort((a, b) => a - b);
    assert.ok(slowerMs < fasterMs * 5, `known (${knownUsernameMs}ms) and unknown (${unknownUsernameMs}ms) username logins must take roughly the same time, not an order of magnitude apart`);

    // self-service password change: wrong current password rejected,
    // correct flow signs out every other session, leaves this one alone
    const secondServerAdminLogin = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=serveradmin&password=another-long-password",
      redirect: "manual",
    });
    const serverAdminCookie2 = extractCookie(secondServerAdminLogin);
    assert.ok(serverAdminCookie2, "a second concurrent session for the same account must be possible");

    const badCurrentPwRes = await postAndFollowFlash(`${base}/admin/accounts/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: serverAdminCookie },
      body: "current_password=wrong-password&new_password=brand-new-password-1&confirm_password=brand-new-password-1",
    });
    assert.match(await badCurrentPwRes.text(), /Current password is incorrect/, "wrong current password must be rejected");

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

    // invite-based account creation
    const createInviteRes = await postAndFollowFlash(`${base}/admin/accounts/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: "",
    });
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

    // save updates the pending invite's can_manage_accounts flag,
    // a server permission is its own popup-endpoint call, same as a real account
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

    // revoke deletes it outright
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

    // invite redemption: the invitee picks their own username/password,
    // permissions come from what the invite already had set
    const redeemInviteRes = await postAndFollowFlash(`${base}/admin/accounts/invite`, {
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

    // a/b self-update page: site-admin only, sidebar icon tracks
    // whether update_state actually has an available version
    const forbiddenUpdatePage = await fetch(`${base}/admin/update`, { headers: { Cookie: serverAdminCookie } });
    assert.equal(forbiddenUpdatePage.status, 403, "a non-site-admin must not reach the update page");

    const dashBeforeUpdate = await (await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.doesNotMatch(dashBeforeUpdate, /href="\/admin\/update"/, "no update nav item when update_state has no available version");

    const updatePageRes = await fetch(`${base}/admin/update`, { headers: { Cookie: siteAdminCookie } });
    assert.equal(updatePageRes.status, 200);
    const updatePageHtml = await updatePageRes.text();
    assert.match(updatePageHtml, /latest version/i);
    assert.match(updatePageHtml, /<form method="post" action="\/admin\/update\/check">/, "the update page must offer a manual check button");

    db.prepare("UPDATE update_state SET available_version = ?, changelog_url = ? WHERE id = 1").run("9.9.9", "https://example.test/changelog");
    const dashAfterUpdate = await (await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.match(dashAfterUpdate, /href="\/admin\/update"/, "update nav item must appear once update_state has an available version");

    const updatePageWithUpdateHtml = await (await fetch(`${base}/admin/update`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.match(updatePageWithUpdateHtml, /9\.9\.9/);
    assert.match(updatePageWithUpdateHtml, /Update now/);

    db.prepare("UPDATE update_state SET available_version = NULL, changelog_url = NULL WHERE id = 1").run();

    // "check now": manual trigger for checkForUpdate(), against the dummy github api
    const forbiddenCheckNow = await fetch(`${base}/admin/update/check`, { method: "POST", headers: { Cookie: serverAdminCookie } });
    assert.equal(forbiddenCheckNow.status, 403, "a non-site-admin must not be able to trigger a check either");

    function serveDummyManifest(signed, privateKey) {
      dummyGithubRespond = (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url.includes("/releases/latest")) {
          res.end(JSON.stringify({ assets: [{ name: "signed_updates.json", browser_download_url: `${dummyGithubBase}/signed_updates.json` }] }));
        } else {
          const signature = crypto.sign(null, Buffer.from(JSON.stringify(signed)), privateKey).toString("hex");
          res.end(JSON.stringify({ ...signed, signature }));
        }
      };
    }

    // signed with a throwaway key the hardcoded public key never
    // accepts, deterministic regardless of whether the real key exists
    serveDummyManifest(
      { version: "9.9.9-bad", changelog_url: "https://example.test/changelog", needs_service_update: false, downloads: [] },
      crypto.generateKeyPairSync("ed25519").privateKey
    );
    const failedCheckRes = await postAndFollowFlash(`${base}/admin/update/check`, { method: "POST", headers: { Cookie: siteAdminCookie } });
    assert.match(await failedCheckRes.text(), /Check failed/, "a check that fails signature verification must not report success");

    // a genuinely newer, properly-signed release, only runs where the
    // real signing key exists, same gating convention as update-check.test.js
    const REAL_PRIVATE_KEY_PATH = path.join(__dirname, "..", "local-only", "keys", "update-signing-key.pem");
    if (fs.existsSync(REAL_PRIVATE_KEY_PATH)) {
      serveDummyManifest(
        {
          version: "9.9.9-found",
          changelog_url: "https://example.test/changelog",
          needs_service_update: false,
          downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "a".repeat(64) }],
        },
        crypto.createPrivateKey(fs.readFileSync(REAL_PRIVATE_KEY_PATH, "utf8"))
      );
      const foundCheckRes = await fetch(`${base}/admin/update/check`, { method: "POST", headers: { Cookie: siteAdminCookie } });
      assert.equal(foundCheckRes.status, 200);
      assert.match(await foundCheckRes.text(), /9\.9\.9-found/);
      const dashAfterCheckNow = await (await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } })).text();
      assert.match(dashAfterCheckNow, /href="\/admin\/update"/, "update nav item must appear after a manual check finds an update");
    }

    db.prepare("UPDATE update_state SET available_version = NULL, changelog_url = NULL WHERE id = 1").run();

    // "update now" cooldown: a double-click must not fire a second
    // applyUpdate() while one is in flight, stub the shared module object
    // so server.js's own already-required reference sees the stub too
    const realApplyUpdate = updateCheck.applyUpdate;
    let applyUpdateCalls = 0;
    updateCheck.applyUpdate = async () => {
      applyUpdateCalls++;
    };
    try {
      const forbiddenTriggerUpdate = await fetch(`${base}/admin/update`, {
        method: "POST",
        headers: { Cookie: serverAdminCookie },
      });
      assert.equal(forbiddenTriggerUpdate.status, 403, "a non-site-admin must not be able to trigger an update either");
      assert.equal(applyUpdateCalls, 0);

      const firstTrigger = await postAndFollowFlash(`${base}/admin/update`, { method: "POST", headers: { Cookie: siteAdminCookie } });
      assert.match(await firstTrigger.text(), /Update started/);
      assert.equal(applyUpdateCalls, 1);
      assert.ok(db.prepare("SELECT update_triggered_at FROM update_state WHERE id = 1").get().update_triggered_at, "update_triggered_at must be set after triggering");

      const secondTrigger = await postAndFollowFlash(`${base}/admin/update`, { method: "POST", headers: { Cookie: siteAdminCookie } });
      assert.match(await secondTrigger.text(), /try again after \d\d:\d\d:\d\d UTC/, "an update triggered within the cooldown window must be rejected, not started again");
      assert.equal(applyUpdateCalls, 1, "a rejected trigger must not call applyUpdate() a second time");

      // back-date past the 60s cooldown window, a third trigger must succeed
      db.prepare("UPDATE update_state SET update_triggered_at = ? WHERE id = 1").run(new Date(Date.now() - 61_000).toISOString());
      const thirdTrigger = await postAndFollowFlash(`${base}/admin/update`, { method: "POST", headers: { Cookie: siteAdminCookie } });
      assert.match(await thirdTrigger.text(), /Update started/);
      assert.equal(applyUpdateCalls, 2, "a trigger after the cooldown has elapsed must call applyUpdate() again");
    } finally {
      updateCheck.applyUpdate = realApplyUpdate;
      db.prepare("UPDATE update_state SET update_triggered_at = NULL WHERE id = 1").run();
    }

    // settings: site-wide "always show update nav" toggle
    const forbiddenSettingsPage = await fetch(`${base}/admin/settings`, { headers: { Cookie: serverAdminCookie } });
    assert.equal(forbiddenSettingsPage.status, 403, "a non-site-admin must not reach the settings page");

    const settingsPageRes = await fetch(`${base}/admin/settings`, { headers: { Cookie: siteAdminCookie } });
    assert.equal(settingsPageRes.status, 200);
    const settingsHtml = await settingsPageRes.text();
    assert.match(settingsHtml, /<form method="post" action="\/admin\/settings">/);
    assert.doesNotMatch(settingsHtml, /name="pin_update_nav"[^>]*checked/, "the toggle must start unchecked by default");

    // available_version is null here (reset above), the update icon
    // stays hidden until the setting is turned on
    const dashBeforePin = await (await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.doesNotMatch(dashBeforePin, /href="\/admin\/update"/);

    const pinOnRes = await postAndFollowFlash(`${base}/admin/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: "pin_update_nav=1",
    });
    assert.match(await pinOnRes.text(), /Settings saved/);

    const dashAfterPin = await (await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.match(dashAfterPin, /href="\/admin\/update"/, "the Update nav item must appear once pinned, even with no update pending");
    assert.match(dashAfterPin, /Software update/, "the pinned-but-up-to-date label must not be the usual \"Update available: ...\" text");

    const settingsPageCheckedRes = await fetch(`${base}/admin/settings`, { headers: { Cookie: siteAdminCookie } });
    assert.match(await settingsPageCheckedRes.text(), /name="pin_update_nav"[^>]*checked/, "the settings page must reflect the persisted on state");

    // an unchecked checkbox sends no field at all, simulate that with
    // an empty body, not pin_update_nav=0
    const pinOffRes = await postAndFollowFlash(`${base}/admin/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: "",
    });
    assert.match(await pinOffRes.text(), /Settings saved/);

    const dashAfterUnpin = await (await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.doesNotMatch(dashAfterUnpin, /href="\/admin\/update"/, "the Update nav item must disappear again once un-pinned, with no update pending");

    // logs: auth-gate's own + agent's, merged into one timeline (site admin only)
    const forbiddenLogsPage = await fetch(`${base}/admin/logs`, { headers: { Cookie: serverAdminCookie } });
    assert.equal(forbiddenLogsPage.status, 403, "a non-site-admin must not reach the logs page");

    // console.log/warn are already the real wrapped versions, installed
    // when test.before() required ../src/server, same as production
    console.log("AUTH_GATE_LOG_MARKER app-side entry");
    console.error("AUTH_GATE_LOG_MARKER app-side error");
    dummyAgentLogText = JSON.stringify({ t: new Date().toISOString(), level: "log", msg: "AUTH_GATE_LOG_MARKER agent-side entry" });

    const logsRes = await fetch(`${base}/admin/logs`, { headers: { Cookie: siteAdminCookie } });
    assert.equal(logsRes.status, 200);
    const logsHtml = await logsRes.text();
    assert.match(logsHtml, /AUTH_GATE_LOG_MARKER app-side entry/);
    assert.match(logsHtml, /AUTH_GATE_LOG_MARKER app-side error/);
    assert.match(logsHtml, /AUTH_GATE_LOG_MARKER agent-side entry/, "the agent's own log must be merged in too");
    assert.match(logsHtml, /id="latest"/, "needs a scroll anchor for landing at the newest entry");
    assert.match(logsHtml, /<form method="get" action="\/admin\/logs#latest" class="log-filters">/);
    assert.match(logsHtml, />agent</, "the agent entry needs its source badge");
    assert.match(logsHtml, />auth-gate</, "the app entries need their source badge");

    // filter by source: app-only must exclude the agent's entry
    const appOnlyHtml = await (await fetch(`${base}/admin/logs?source=app`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.match(appOnlyHtml, /AUTH_GATE_LOG_MARKER app-side entry/);
    assert.doesNotMatch(appOnlyHtml, /AUTH_GATE_LOG_MARKER agent-side entry/, "source=app must exclude agent entries");

    // filter by timespan: an old entry is excluded by a short window
    const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    fs.appendFileSync(authGateLogPath, JSON.stringify({ t: oldTimestamp, level: "log", msg: "AUTH_GATE_LOG_MARKER old entry" }) + "\n");

    const allTimeHtml = await (await fetch(`${base}/admin/logs?since=all`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.match(allTimeHtml, /AUTH_GATE_LOG_MARKER old entry/, "since=all must include the old entry");
    const recentOnlyHtml = await (await fetch(`${base}/admin/logs?since=15m`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.doesNotMatch(recentOnlyHtml, /AUTH_GATE_LOG_MARKER old entry/, "since=15m must exclude a 2h-old entry");

    // an inherited key must not be treated as a valid window, and must
    // not empty the view the way a plain `in` check would (NaN cutoff)
    const inheritedKeyHtml = await (await fetch(`${base}/admin/logs?since=constructor`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.match(inheritedKeyHtml, /AUTH_GATE_LOG_MARKER old entry/, "since=constructor must behave like since=all, not empty the view");

    // verbose filter: debug-level entries hidden by default, shown with verbose=1
    console.debug("AUTH_GATE_LOG_MARKER debug entry");
    const nonVerboseHtml = await (await fetch(`${base}/admin/logs`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.doesNotMatch(nonVerboseHtml, /AUTH_GATE_LOG_MARKER debug entry/, "debug-level entries must be hidden by default");
    const verboseHtml = await (await fetch(`${base}/admin/logs?verbose=1`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.match(verboseHtml, /AUTH_GATE_LOG_MARKER debug entry/, "verbose=1 must reveal debug-level entries");

    // agent unreachable: the auth-gate's own entries still render,
    // with a clear error instead of silently dropping the agent section
    dummyAgentLogsShouldFail = true;
    const degradedRes = await fetch(`${base}/admin/logs`, { headers: { Cookie: siteAdminCookie } });
    assert.equal(degradedRes.status, 200, "an unreachable agent must not fail the whole page");
    const degradedHtml = await degradedRes.text();
    assert.match(degradedHtml, /Could not reach the mission agent/);
    assert.match(degradedHtml, /AUTH_GATE_LOG_MARKER app-side entry/, "the auth-gate's own entries must still render");
    dummyAgentLogsShouldFail = false;

    // session cookie sliding: the browser's own cookie must catch up
    // to what sessions.expires_at already does on every request
    // see docs/Why.md#why-does-getsessionadmin-report-a-cookie-refresh-flag
    const slidingTokenHash = auth.hashToken(siteAdminCookie.split("=")[1]);
    db.prepare("UPDATE sessions SET expires_at = datetime('now', '+30 minutes') WHERE token_hash = ?").run(slidingTokenHash);
    const staleRes = await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } });
    const staleSetCookie = staleRes.headers.get("set-cookie");
    assert.ok(staleSetCookie, "a session more than an hour past its last slide must get its cookie reissued");
    assert.equal(extractCookie(staleRes), siteAdminCookie, "the reissued cookie must carry the same session token, not a new one");
    assert.match(staleSetCookie, /Max-Age=43200/, "the reissued cookie must carry a fresh 12h maxAge");

    // right after a refresh, the session is nowhere near the threshold
    // again, so the cookie must not be reissued on every single request
    const freshRes = await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } });
    assert.equal(extractCookie(freshRes), null, "a session well within the threshold must not get its cookie reissued");

    // logout is a destructive-styled navbar button, post only
    const dashboardHtmlForLogout = await (await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } })).text();
    assert.match(dashboardHtmlForLogout, /<form method="post" action="\/logout" class="logout-form">/);
    assert.match(dashboardHtmlForLogout, /<button type="submit" class="destructive">Sign out<\/button>/);
    const getLogoutRes = await fetch(`${base}/logout`, { headers: { Cookie: siteAdminCookie }, redirect: "manual" });
    assert.equal(getLogoutRes.status, 404, "logout must only accept POST now, not the old GET link");

    // logout actually invalidates the session
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
