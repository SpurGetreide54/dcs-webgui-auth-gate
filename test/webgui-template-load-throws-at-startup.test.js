const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

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

test("a webgui-static that is a plain file (ENOTDIR), not a missing directory, doesn't crash startup, and /s/<slug>/ 503s with the read-error message", async () => {
  // a plain file is a portable stand-in for an unreadable index.html:
  // readFileSync throws ENOTDIR either way, with no dependence on
  // running as root, unlike a chmod-000 permission test
  const webguiStaticPath = path.join(os.tmpdir(), `webgui-template-enotdir-${crypto.randomBytes(6).toString("hex")}`);
  fs.writeFileSync(webguiStaticPath, "not a directory");

  const sqlitePath = tempSqlitePath("webgui-template-throws");
  const authGateLogPath = path.join(os.tmpdir(), `auth-gate-test-log-${crypto.randomBytes(6).toString("hex")}.log`);
  process.env.SQLITE_PATH = sqlitePath;
  process.env.COOKIE_SECURE = "false";
  process.env.WEBGUI_STATIC_PATH = webguiStaticPath;
  process.env.AUTH_GATE_LOG_PATH = authGateLogPath;

  let app, db;
  try {
    // the require itself must not throw: this is the crash this fix prevents
    assert.doesNotThrow(() => {
      app = require("../src/server");
    }, "requiring src/server.js must not throw even when webgui-static/index.html can't be read");
    db = require("../src/db");

    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.on("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
      const setupRes = await fetch(`${base}/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "username=siteadmin&password=correct-horse-battery-staple",
        redirect: "manual",
      });
      const siteAdminCookie = extractCookie(setupRes);

      const insert = db
        .prepare("INSERT INTO servers (slug, name, instance_name) VALUES (?, ?, ?)")
        .run("enotdir-server", "ENOTDIR Server", "Example_Enotdir");
      const serversDb = require("../src/servers");
      serversDb.setAccess(1, insert.lastInsertRowid, { canViewMissions: true });

      const res = await fetch(`${base}/s/enotdir-server/`, { headers: { Cookie: siteAdminCookie } });
      assert.equal(res.status, 503);
      const body = await res.text();
      assert.match(body, /The DCS webgui bundle could not be read/, "the read-error message, not the generic not-installed one");
      assert.doesNotMatch(body, /not installed on this server yet/);
    } finally {
      server.close();
    }
  } finally {
    if (db) db.close();
    cleanupSqlite(sqlitePath);
    fs.rmSync(webguiStaticPath, { force: true });
    for (const suffix of ["", ".1"]) fs.rmSync(authGateLogPath + suffix, { force: true });
  }
});
