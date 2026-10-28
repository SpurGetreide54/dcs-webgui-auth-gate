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

// delete a sqlite file and its wal/shm siblings
function cleanupSqlite(sqlitePath) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(sqlitePath + suffix, { force: true });
}

// pull just the cookie's own name=value out of a set-cookie header
function extractCookie(res) {
  const setCookie = res.headers.get("set-cookie");
  return setCookie ? setCookie.split(";")[0] : null;
}

const AGENT_TOKEN = "webgui-ports-agent-token";

let app, db, sqlitePath, authGateLogPath;
let dummyAgent, dummyAgentPort;
let instancePorts; // instanceName -> port|null
let ensureCalls;

// a minimal http server standing in for the real mission-agent
function startDummyAgent() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean); // ["webgui", "<instance>", "status"|"ensure-port"]
      const instanceName = decodeURIComponent(parts[1] || "");

      if (req.method === "GET" && parts[2] === "status") {
        const port = instancePorts.has(instanceName) ? instancePorts.get(instanceName) : null;
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ configExists: port !== null, webguiPort: port }));
      }

      if (req.method === "POST" && parts[2] === "ensure-port") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          ensureCalls.push({ instanceName, port: body.port });
          if (!instancePorts.get(instanceName)) instancePorts.set(instanceName, body.port);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, webguiPort: instancePorts.get(instanceName), created: true }));
        });
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test.before(async () => {
  dummyAgent = await startDummyAgent();
  dummyAgentPort = dummyAgent.address().port;

  sqlitePath = tempSqlitePath("webgui-ports");
  process.env.SQLITE_PATH = sqlitePath;
  process.env.COOKIE_SECURE = "false";
  process.env.MISSION_AGENT_URL = `http://127.0.0.1:${dummyAgentPort}`;
  process.env.MISSION_AGENT_TOKEN = AGENT_TOKEN;
  // requiring ../src/server installs appLog's console capture, same
  // reasoning as SQLITE_PATH above, just for the log file
  authGateLogPath = path.join(os.tmpdir(), `auth-gate-test-log-${crypto.randomBytes(6).toString("hex")}.log`);
  process.env.AUTH_GATE_LOG_PATH = authGateLogPath;

  app = require("../src/server");
  db = require("../src/db");
});

test.after(async () => {
  await new Promise((resolve) => dummyAgent.close(resolve));
  db.close();
  cleanupSqlite(sqlitePath);
  for (const suffix of ["", ".1"]) fs.rmSync(authGateLogPath + suffix, { force: true });
});

test("webgui-ports: proposes non-colliding ports for missing instances, writes nothing until confirm", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  instancePorts = new Map([
    ["A_has_port", 8200], // already configured, must not be re-proposed or collided with
    ["B_missing", null],
    ["C_missing", null],
  ]);
  ensureCalls = [];

  try {
    const setupRes = await fetch(`${base}/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=siteadmin&password=correct-horse-battery-staple",
      redirect: "manual",
    });
    const siteAdminCookie = extractCookie(setupRes);

    db.prepare("INSERT INTO servers (slug, name, instance_name) VALUES (?, ?, ?)").run("a", "Server A", "A_has_port");
    db.prepare("INSERT INTO servers (slug, name, instance_name) VALUES (?, ?, ?)").run("b", "Server B", "B_missing");
    db.prepare("INSERT INTO servers (slug, name, instance_name) VALUES (?, ?, ?)").run("c", "Server C", "C_missing");

    // review page: proposes 8088/8089 for b/c, skips a's used 8200, writes nothing
    const checkRes = await fetch(`${base}/admin/servers/webgui-ports`, { headers: { Cookie: siteAdminCookie } });
    assert.equal(checkRes.status, 200);
    const checkHtml = await checkRes.text();
    assert.match(checkHtml, /Server B/);
    assert.match(checkHtml, /8088/);
    assert.match(checkHtml, /Server C/);
    assert.match(checkHtml, /8089/);
    assert.doesNotMatch(checkHtml, /Server A/, "already-configured servers must not appear in the proposal list");
    assert.equal(ensureCalls.length, 0, "reviewing the proposal must not write anything");

    // confirm: writes exactly b and c, with the proposed ports
    const confirmRes = await fetch(`${base}/admin/servers/webgui-ports/confirm`, {
      method: "POST",
      headers: { Cookie: siteAdminCookie },
    });
    assert.equal(confirmRes.status, 200);
    assert.equal(ensureCalls.length, 2);
    assert.deepEqual(
      ensureCalls.sort((a, b) => a.instanceName.localeCompare(b.instanceName)),
      [
        { instanceName: "B_missing", port: 8088 },
        { instanceName: "C_missing", port: 8089 },
      ]
    );

    // re-checking afterward, nothing left to propose
    const recheckRes = await fetch(`${base}/admin/servers/webgui-ports`, { headers: { Cookie: siteAdminCookie } });
    const recheckHtml = await recheckRes.text();
    assert.match(recheckHtml, /Every configured server already has/);
  } finally {
    server.close();
  }
});

test("webgui-ports: a restricted (non-account-manager) admin can't reach the review page", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  instancePorts = new Map();
  ensureCalls = [];

  try {
    // reuses the site admin from the previous test, same app/db instance
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
      body: "username=restricted-webgui-ports&password=another-long-password",
      redirect: "manual",
    });
    assert.equal(createRes.status, 302);
    const restrictedLogin = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "username=restricted-webgui-ports&password=another-long-password",
      redirect: "manual",
    });
    const restrictedCookie = extractCookie(restrictedLogin);

    const res = await fetch(`${base}/admin/servers/webgui-ports`, { headers: { Cookie: restrictedCookie } });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});
