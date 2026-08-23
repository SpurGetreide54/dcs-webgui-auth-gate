const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const tar = require("tar");

function tempSqlitePath(label) {
  return path.join(os.tmpdir(), `auth-gate-test-${label}-${crypto.randomBytes(6).toString("hex")}.sqlite`);
}

function cleanupSqlite(sqlitePath) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(sqlitePath + suffix, { force: true });
}

function extractCookie(res) {
  const setCookie = res.headers.get("set-cookie");
  return setCookie ? setCookie.split(";")[0] : null;
}

async function packDirToBuffer(dir) {
  const chunks = [];
  for await (const chunk of tar.c({ cwd: dir }, ["."])) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const AGENT_TOKEN = "webgui-sync-agent-token";
const GOOD_INSTALL_PATH = "C:\\DCS\\install-with-webgui";
const BAD_INSTALL_PATH = "C:\\DCS\\install-missing-webgui";

let app, db, sqlitePath, webguiStaticPath;
let dummyAgent, dummyAgentPort;
let bundleTar, bundleRequests;

function startDummyAgent() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/dcs-install/webgui-bundle") {
        res.writeHead(404);
        return res.end("not found");
      }
      const installPath = url.searchParams.get("path");
      bundleRequests.push(installPath);

      if (installPath !== GOOD_INSTALL_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end(`No WebGUI folder found at ${installPath}\\WebGUI (index.html missing).`);
      }
      res.writeHead(200, { "Content-Type": "application/x-tar" });
      res.end(bundleTar);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test.before(async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "webgui-sync-fixture-"));
  fs.mkdirSync(path.join(fixtureDir, "js"), { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, "index.html"), "<html>synced dcs webgui</html>");
  fs.writeFileSync(path.join(fixtureDir, "js", "app.js"), "console.log('synced');");
  bundleTar = await packDirToBuffer(fixtureDir);
  fs.rmSync(fixtureDir, { recursive: true, force: true });

  dummyAgent = await startDummyAgent();
  dummyAgentPort = dummyAgent.address().port;

  sqlitePath = tempSqlitePath("webgui-sync");
  webguiStaticPath = fs.mkdtempSync(path.join(os.tmpdir(), "webgui-sync-static-"));
  process.env.SQLITE_PATH = sqlitePath;
  process.env.COOKIE_SECURE = "false";
  process.env.MISSION_AGENT_URL = `http://127.0.0.1:${dummyAgentPort}`;
  process.env.MISSION_AGENT_TOKEN = AGENT_TOKEN;
  process.env.WEBGUI_STATIC_PATH = webguiStaticPath;

  app = require("../src/server");
  db = require("../src/db");
});

test.after(async () => {
  await new Promise((resolve) => dummyAgent.close(resolve));
  db.close();
  cleanupSqlite(sqlitePath);
  fs.rmSync(webguiStaticPath, { recursive: true, force: true });
});

test("webgui-sync: syncs webgui-static/ from the selected server's DCS install", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  bundleRequests = [];

  try {
    const setupRes = await fetch(`${base}/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=siteadmin&password=correct-horse-battery-staple",
      redirect: "manual",
    });
    const siteAdminCookie = extractCookie(setupRes);

    const insert = db
      .prepare("INSERT INTO servers (slug, name, instance_name, dcs_install_path) VALUES (?, ?, ?, ?)")
      .run("main", "Main Server", "Example_Community", GOOD_INSTALL_PATH);
    const serverId = insert.lastInsertRowid;

    // --- review page offers the server as a source ---
    const reviewRes = await fetch(`${base}/admin/servers/webgui-sync`, { headers: { Cookie: siteAdminCookie } });
    assert.equal(reviewRes.status, 200);
    const reviewHtml = await reviewRes.text();
    assert.match(reviewHtml, /Main Server/);

    // --- confirm: pulls the tar from the agent and replaces webgui-static/ ---
    const syncRes = await fetch(`${base}/admin/servers/webgui-sync/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: `server_id=${serverId}`,
    });
    assert.equal(syncRes.status, 200);
    const syncHtml = await syncRes.text();
    assert.match(syncHtml, /Synced webgui-static/);
    assert.deepEqual(bundleRequests, [GOOD_INSTALL_PATH]);

    assert.equal(fs.readFileSync(path.join(webguiStaticPath, "index.html"), "utf8"), "<html>synced dcs webgui</html>");
    assert.equal(fs.readFileSync(path.join(webguiStaticPath, "js", "app.js"), "utf8"), "console.log('synced');");
  } finally {
    server.close();
  }
});

test("webgui-sync: a failed bundle fetch leaves the existing webgui-static/ untouched", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  bundleRequests = [];

  // Pre-existing bundle, as if a previous sync already ran.
  fs.writeFileSync(path.join(webguiStaticPath, "index.html"), "<html>pre-existing bundle</html>");

  try {
    const loginRes = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=siteadmin&password=correct-horse-battery-staple",
      redirect: "manual",
    });
    const siteAdminCookie = extractCookie(loginRes);

    const insert = db
      .prepare("INSERT INTO servers (slug, name, instance_name, dcs_install_path) VALUES (?, ?, ?, ?)")
      .run("broken", "Broken Server", "Example_Broken", BAD_INSTALL_PATH);
    const serverId = insert.lastInsertRowid;

    const syncRes = await fetch(`${base}/admin/servers/webgui-sync/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: `server_id=${serverId}`,
    });
    assert.equal(syncRes.status, 502);
    const syncHtml = await syncRes.text();
    assert.match(syncHtml, /Sync failed/);

    assert.equal(
      fs.readFileSync(path.join(webguiStaticPath, "index.html"), "utf8"),
      "<html>pre-existing bundle</html>",
      "a failed sync must not touch the existing bundle"
    );
  } finally {
    server.close();
  }
});

test("webgui-sync: rejects confirming without a server that has an install path set", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  bundleRequests = [];

  try {
    const loginRes = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=siteadmin&password=correct-horse-battery-staple",
      redirect: "manual",
    });
    const siteAdminCookie = extractCookie(loginRes);

    const insert = db
      .prepare("INSERT INTO servers (slug, name, instance_name) VALUES (?, ?, ?)")
      .run("nopath", "No Path Server", "Example_NoPath");

    const res = await fetch(`${base}/admin/servers/webgui-sync/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: `server_id=${insert.lastInsertRowid}`,
    });
    assert.equal(res.status, 400);
    assert.equal(bundleRequests.length, 0, "must not call the agent for a server with no install path");
  } finally {
    server.close();
  }
});

test("webgui-sync: a restricted (non-account-manager) admin can't reach the review page or trigger a sync", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  bundleRequests = [];

  try {
    const loginRes = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=siteadmin&password=correct-horse-battery-staple",
      redirect: "manual",
    });
    const cookie = extractCookie(loginRes);

    const createRes = await fetch(`${base}/admin/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
      body: "username=restricted-webgui-sync&password=another-long-password",
      redirect: "manual",
    });
    assert.equal(createRes.status, 302);
    const restrictedLogin = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=restricted-webgui-sync&password=another-long-password",
      redirect: "manual",
    });
    const restrictedCookie = extractCookie(restrictedLogin);

    const getRes = await fetch(`${base}/admin/servers/webgui-sync`, { headers: { Cookie: restrictedCookie } });
    assert.equal(getRes.status, 403);

    const postRes = await fetch(`${base}/admin/servers/webgui-sync/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: restrictedCookie },
      body: "server_id=1",
    });
    assert.equal(postRes.status, 403);
    assert.equal(bundleRequests.length, 0);
  } finally {
    server.close();
  }
});
