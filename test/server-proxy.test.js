const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

function startDummyHttpServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function tempSqlitePath(label) {
  return path.join(os.tmpdir(), `auth-gate-test-${label}-${crypto.randomBytes(6).toString("hex")}.sqlite`);
}

function cleanupSqlite(sqlitePath) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(sqlitePath + suffix, { force: true });
}

const AGENT_TOKEN = "test-agent-token";

let db, serversDb, controlTokens, serverProxy;
let dummyAgent, dummyAgentPort;
let lastAgentRequest;
let sqlitePath;
let allowedAdminId, otherAdminId, allowedServerId, otherServerId;

test.before(async () => {
  dummyAgent = await startDummyHttpServer((req, res) => {
    lastAgentRequest = { path: req.url, authorization: req.headers.authorization };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: req.url }));
  });
  dummyAgentPort = dummyAgent.address().port;

  sqlitePath = tempSqlitePath("server-proxy");
  process.env.SQLITE_PATH = sqlitePath;
  process.env.MISSION_AGENT_URL = `http://127.0.0.1:${dummyAgentPort}`;
  process.env.MISSION_AGENT_TOKEN = AGENT_TOKEN;

  db = require("../src/db");
  serversDb = require("../src/servers");
  controlTokens = require("../src/controlTokens");
  serverProxy = require("../src/serverProxy");

  allowedAdminId = db.prepare("INSERT INTO admins (username, password_hash) VALUES (?, ?)").run("allowed", "x").lastInsertRowid;
  otherAdminId = db.prepare("INSERT INTO admins (username, password_hash) VALUES (?, ?)").run("other", "x").lastInsertRowid;
  allowedServerId = db
    .prepare("INSERT INTO servers (slug, name, instance_name) VALUES (?, ?, ?)")
    .run("allowed-server", "Allowed", "Example_Allowed").lastInsertRowid;
  otherServerId = db
    .prepare("INSERT INTO servers (slug, name, instance_name) VALUES (?, ?, ?)")
    .run("other-server", "Other", "Example_Other").lastInsertRowid;
  serversDb.setAccess(allowedAdminId, allowedServerId, { canUploadMissions: false });
});

test.after(async () => {
  await new Promise((resolve) => dummyAgent.close(resolve));
  db.close();
  cleanupSqlite(sqlitePath);
});

test("control-port proxy: valid token for a granted server reaches the agent, scoped by instance_name", async () => {
  const { app } = serverProxy.buildControlProxyApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = controlTokens.mint(allowedAdminId, allowedServerId);

  try {
    const res = await fetch(`${base}/some/path`, { headers: { "X-Auth-Gate-Token": token } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.path, "/webgui/Example_Allowed/some/path", "must route through the agent under /webgui/<instance_name>");
    assert.equal(lastAgentRequest.authorization, `Bearer ${AGENT_TOKEN}`, "agent call must carry the shared bearer token, not the browser's own X-Auth-Gate-Token");
  } finally {
    server.close();
  }
});

test("control-port proxy: rejects a missing token", async () => {
  const { app } = serverProxy.buildControlProxyApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${base}/some/path`);
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test("control-port proxy: token minted for a server the admin was never granted is rejected", async () => {
  const { app } = serverProxy.buildControlProxyApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Simulates a forged/stale token. The admin has no admin_server_access row for otherServerId.
  const token = controlTokens.mint(otherAdminId, otherServerId);

  try {
    const res = await fetch(`${base}/some/path`, { headers: { "X-Auth-Gate-Token": token } });
    assert.equal(res.status, 403, "changing which server a token claims to be for must not reach it without a real grant");
  } finally {
    server.close();
  }
});

test("control-port proxy: an expired/unknown token is rejected", async () => {
  const { app } = serverProxy.buildControlProxyApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${base}/some/path`, { headers: { "X-Auth-Gate-Token": "not-a-real-token" } });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test("control-port proxy: a token used before its TTL slides forward and survives past the original flat expiry", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { app } = serverProxy.buildControlProxyApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = controlTokens.mint(allowedAdminId, allowedServerId);

  try {
    // 4 minutes in, still within the original 5-minute TTL -- the real
    // webgui's own 2-second polling would have hit this many times over by
    // now, this just simulates one such poll.
    t.mock.timers.tick(4 * 60 * 1000);
    const midRes = await fetch(`${base}/some/path`, { headers: { "X-Auth-Gate-Token": token } });
    assert.equal(midRes.status, 200, "a poll within the original TTL must succeed and slide the token forward");

    // 8 minutes since mint -- past where the original flat TTL would have
    // expired it, but within TOKEN_TTL_MS of the mid-flight poll above.
    t.mock.timers.tick(4 * 60 * 1000);
    const laterRes = await fetch(`${base}/some/path`, { headers: { "X-Auth-Gate-Token": token } });
    assert.equal(laterRes.status, 200, "a token used recently enough must still be accepted past its original flat expiry");
  } finally {
    server.close();
  }
});

test("control-port proxy: an unused token still expires after its flat TTL with no renewal", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { app } = serverProxy.buildControlProxyApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = controlTokens.mint(allowedAdminId, allowedServerId);

  try {
    t.mock.timers.tick(6 * 60 * 1000); // past the 5-minute TTL, never used in between
    const res = await fetch(`${base}/some/path`, { headers: { "X-Auth-Gate-Token": token } });
    assert.equal(res.status, 403, "a token that's never been used since mint must still expire on its original flat TTL");
  } finally {
    server.close();
  }
});

test("control-port proxy: a repeatedly-used token still hits its absolute ceiling", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { app } = serverProxy.buildControlProxyApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = controlTokens.mint(allowedAdminId, allowedServerId);

  try {
    // Poll every 4 minutes -- comfortably inside the 5-minute sliding
    // window, so the token never lapses on its own -- for just past the
    // 12-hour ceiling.
    const pollIntervalMs = 4 * 60 * 1000;
    const totalPolls = Math.ceil((12 * 60 * 60 * 1000) / pollIntervalMs) + 1;
    let lastStatus;
    for (let i = 0; i < totalPolls; i++) {
      t.mock.timers.tick(pollIntervalMs);
      const res = await fetch(`${base}/some/path`, { headers: { "X-Auth-Gate-Token": token } });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 403, "a token must still hit its absolute ceiling even if it's always within its sliding window");
  } finally {
    server.close();
  }
});

test("control-port proxy: CORS preflight reflects the requesting origin", async () => {
  const { app } = serverProxy.buildControlProxyApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${base}/some/path`, {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:3000", "Access-Control-Request-Headers": "X-Auth-Gate-Token" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://127.0.0.1:3000");
  } finally {
    server.close();
  }
});
