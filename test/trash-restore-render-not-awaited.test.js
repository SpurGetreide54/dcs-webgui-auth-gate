const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

// a fresh, unique sqlite path per test file, under the os temp dir
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

let app, db, serversDb, sqlitePath, authGateLogPath;
let dummyAgent, dummyAgentPort;

// a minimal http server standing in for the real mission-agent:
// always answers trash/trash-restore with a plain ok
function startDummyAgent() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test.before(async () => {
  dummyAgent = await startDummyAgent();
  dummyAgentPort = dummyAgent.address().port;

  sqlitePath = tempSqlitePath("trash-restore-render");
  process.env.SQLITE_PATH = sqlitePath;
  process.env.COOKIE_SECURE = "false";
  process.env.MISSION_AGENT_URL = `http://127.0.0.1:${dummyAgentPort}`;
  process.env.MISSION_AGENT_TOKEN = "trash-restore-render-token";
  authGateLogPath = path.join(os.tmpdir(), `auth-gate-test-log-${crypto.randomBytes(6).toString("hex")}.log`);
  process.env.AUTH_GATE_LOG_PATH = authGateLogPath;

  app = require("../src/server");
  db = require("../src/db");
  serversDb = require("../src/servers");
});

test.after(async () => {
  await new Promise((resolve) => dummyAgent.close(resolve));
  db.close();
  cleanupSqlite(sqlitePath);
  for (const suffix of ["", ".1"]) fs.rmSync(authGateLogPath + suffix, { force: true });
});

// requireServerAccess's own permission check goes through hasPermission,
// which calls servers.js's local getAccess directly, not through this
// exported reference, so mocking serversDb.getAccess only ever intercepts
// the one call that matters here: loadMissionAccess's, deep inside the
// final, previously-unawaited renderMissionsPage -- a stand-in for a
// transient SQLITE_BUSY-class failure hitting that one query
function throwOnNextGetAccess(t) {
  t.mock.method(serversDb, "getAccess", () => {
    throw new Error("simulated SQLITE_BUSY");
  });
}

test("trash: a renderMissionsPage rejection reaches errorHandler as a 500, and the server stays alive", async (t) => {
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
      .run("trash-crash", "Trash Crash Server", "Example_TrashCrash");
    serversDb.setAccess(1, insert.lastInsertRowid, { canDeleteMissions: true });

    // call 1: requireServerAccess's own permission check, must succeed
    // call 2: loadMissionAccess inside the final, previously-unawaited renderMissionsPage
    throwOnNextGetAccess(t);

    const res = await fetch(`${base}/s/trash-crash/missions/trash`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: "mission=some-mission.miz",
    });
    assert.equal(res.status, 500, "a rejection inside the final, previously-unawaited render must reach errorHandler as a 500, not crash the process");

    // confirms the server itself survived: an unrelated request still works
    const stillAliveRes = await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } });
    assert.equal(stillAliveRes.status, 200, "the server must still answer after the rejection above");
  } finally {
    server.close();
  }
});

test("restore: a renderMissionsPage rejection reaches errorHandler as a 500, and the server stays alive", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

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
      .run("restore-crash", "Restore Crash Server", "Example_RestoreCrash");
    serversDb.setAccess(1, insert.lastInsertRowid, { canDeleteMissions: true });

    throwOnNextGetAccess(t);

    const res = await fetch(`${base}/s/restore-crash/missions/trash/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: siteAdminCookie },
      body: "trash=some-mission.miz.123",
    });
    assert.equal(res.status, 500, "a rejection inside the final, previously-unawaited render must reach errorHandler as a 500, not crash the process");

    const stillAliveRes = await fetch(`${base}/`, { headers: { Cookie: siteAdminCookie } });
    assert.equal(stillAliveRes.status, 200, "the server must still answer after the rejection above");
  } finally {
    server.close();
  }
});
