const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const tar = require("tar");

const TOKEN = "agent-test-token";
const savedGamesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mission-agent-test-"));
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-agent-outside-"));
const dcsInstallRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mission-agent-dcs-install-"));

process.env.AGENT_PORT = "0";
process.env.MISSION_AGENT_TOKEN = TOKEN;
process.env.DCS_SAVED_GAMES_ROOT = savedGamesRoot;

const app = require("../src/agent");

let server, base;
const INSTANCE = "Example_Training";

function instanceDir(name = INSTANCE) {
  return path.join(savedGamesRoot, name);
}

test.before(async () => {
  fs.mkdirSync(instanceDir(), { recursive: true });
  fs.mkdirSync(path.join(dcsInstallRoot, "WebGUI", "js"), { recursive: true });
  fs.writeFileSync(path.join(dcsInstallRoot, "WebGUI", "index.html"), "<html>real dcs webgui</html>");
  fs.writeFileSync(path.join(dcsInstallRoot, "WebGUI", "js", "app.js"), "console.log('app');");
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(savedGamesRoot, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
  fs.rmSync(dcsInstallRoot, { recursive: true, force: true });
});

function uploadForm(filename, instanceName) {
  const form = new FormData();
  form.append("instance_name", instanceName);
  form.append("mission", new Blob([Buffer.from("fake miz contents")]), filename);
  return form;
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

// ---- upload ----

test("rejects requests with no token", async () => {
  const res = await fetch(`${base}/upload`, { method: "POST", body: uploadForm("m.miz", INSTANCE) });
  assert.equal(res.status, 401);
});

test("rejects requests with the wrong token", async () => {
  const res = await fetch(`${base}/upload`, {
    method: "POST",
    headers: { Authorization: "Bearer wrong-token" },
    body: uploadForm("m.miz", INSTANCE),
  });
  assert.equal(res.status, 401);
});

test("writes a valid .miz upload into <instance>/Missions", async () => {
  const res = await fetch(`${base}/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: uploadForm("real-mission.miz", INSTANCE),
  });
  assert.equal(res.status, 200);
  const written = fs.readFileSync(path.join(instanceDir(), "Missions", "real-mission.miz"), "utf8");
  assert.equal(written, "fake miz contents");
});

test("rejects an instance_name with path-traversal characters", async () => {
  const res = await fetch(`${base}/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: uploadForm("m.miz", "../outside"),
  });
  assert.equal(res.status, 400);
});

test("rejects a path-traversal filename instead of escaping the mission folder", async () => {
  const res = await fetch(`${base}/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: uploadForm("../../../etc/passwd.miz", INSTANCE),
  });
  // Whatever status it returns, the decisive check is that nothing landed outside the instance dir.
  assert.ok(res.status === 400 || res.status === 200, `unexpected status ${res.status}`);
  assert.equal(fs.existsSync(path.join(outsideDir, "passwd.miz")), false);
  const escapedPath = path.resolve(instanceDir(), "Missions", "..", "..", "..", "etc", "passwd.miz");
  assert.equal(fs.existsSync(escapedPath), false, "path traversal must not escape the instance folder");
});

test("rejects non-.miz files", async () => {
  const res = await fetch(`${base}/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: uploadForm("not-a-mission.txt", INSTANCE),
  });
  assert.equal(res.status, 400);
});

// ---- webgui control port: status + ensure-port ----

test("status reports no config and no port when autoexec.cfg doesn't exist", async () => {
  const res = await fetch(`${base}/webgui/${INSTANCE}/status`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { configExists: false, webguiPort: null });
});

test("status picks up webgui_port from a real autoexec.cfg", async () => {
  const instance = "Example_WithConfig";
  fs.mkdirSync(path.join(instanceDir(instance), "Config"), { recursive: true });
  fs.writeFileSync(path.join(instanceDir(instance), "Config", "autoexec.cfg"), 'some_other_key = "x"\nwebgui_port = 8123\n');

  const res = await fetch(`${base}/webgui/${instance}/status`, { headers: authHeaders() });
  const body = await res.json();
  assert.deepEqual(body, { configExists: true, webguiPort: 8123 });
});

// Exact bytes from a real, production autoexec.cfg: unquoted numeric,
// unquoted boolean, and a quoted string value alongside each other, no
// trailing newline after the last line. Confirms the regex against a
// genuine DCS-authored file shape, not just a synthetic fixture.
test("status parses a byte-for-byte real-world autoexec.cfg with mixed value types", async () => {
  const instance = "Example_RealWorldFormat";
  fs.mkdirSync(path.join(instanceDir(instance), "Config"), { recursive: true });
  fs.writeFileSync(
    path.join(instanceDir(instance), "Config", "autoexec.cfg"),
    'webgui_port = 8089\ndisable_write_track = true\ncrash_report_mode = "silent"'
  );

  const res = await fetch(`${base}/webgui/${instance}/status`, { headers: authHeaders() });
  const body = await res.json();
  assert.deepEqual(body, { configExists: true, webguiPort: 8089 });
});

test("ensure-port appends onto a real-world multi-key file without disturbing the other keys", async () => {
  const instance = "Example_RealWorldAppend";
  fs.mkdirSync(path.join(instanceDir(instance), "Config"), { recursive: true });
  fs.writeFileSync(
    path.join(instanceDir(instance), "Config", "autoexec.cfg"),
    'disable_write_track = true\ncrash_report_mode = "silent"'
  );

  const res = await fetch(`${base}/webgui/${instance}/ensure-port`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ port: 8090 }),
  });
  assert.equal(res.status, 200);
  const contents = fs.readFileSync(path.join(instanceDir(instance), "Config", "autoexec.cfg"), "utf8");
  assert.match(contents, /disable_write_track = true/, "existing key must survive");
  assert.match(contents, /crash_report_mode = "silent"/, "existing key must survive");
  assert.match(contents, /webgui_port = 8090/);
});

test("status rejects an invalid instance name before touching the filesystem", async () => {
  // ".." itself gets collapsed by URL dot-segment normalization before the
  // request is even sent. This exercises the regex guard with a value that
  // isn't valid Windows-folder-safe, but survives normalization intact.
  const res = await fetch(`${base}/webgui/${encodeURIComponent("not*valid")}/status`, { headers: authHeaders() });
  assert.equal(res.status, 400);
});

test("ensure-port creates a fresh single-line file when none exists", async () => {
  const instance = "Example_Fresh";
  fs.mkdirSync(instanceDir(instance), { recursive: true });

  const res = await fetch(`${base}/webgui/${instance}/ensure-port`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ port: 8089 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, webguiPort: 8089, created: true });
  const contents = fs.readFileSync(path.join(instanceDir(instance), "Config", "autoexec.cfg"), "utf8");
  assert.equal(contents, "webgui_port = 8089\n");
});

test("ensure-port appends without clobbering existing unrelated config", async () => {
  const instance = "Example_HasOtherKeys";
  fs.mkdirSync(path.join(instanceDir(instance), "Config"), { recursive: true });
  fs.writeFileSync(path.join(instanceDir(instance), "Config", "autoexec.cfg"), 'net.log_onerror = true\n');

  const res = await fetch(`${base}/webgui/${instance}/ensure-port`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ port: 8090 }),
  });
  assert.equal(res.status, 200);
  const contents = fs.readFileSync(path.join(instanceDir(instance), "Config", "autoexec.cfg"), "utf8");
  assert.match(contents, /net\.log_onerror = true/, "existing config must survive");
  assert.match(contents, /webgui_port = 8090/);
});

test("ensure-port is a no-op when the key is already present", async () => {
  const instance = "Example_AlreadySet";
  fs.mkdirSync(path.join(instanceDir(instance), "Config"), { recursive: true });
  fs.writeFileSync(path.join(instanceDir(instance), "Config", "autoexec.cfg"), "webgui_port = 9999\n");

  const res = await fetch(`${base}/webgui/${instance}/ensure-port`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ port: 8091 }),
  });
  const body = await res.json();
  assert.deepEqual(body, { ok: true, webguiPort: 9999, created: false });
  const contents = fs.readFileSync(path.join(instanceDir(instance), "Config", "autoexec.cfg"), "utf8");
  assert.equal(contents, "webgui_port = 9999\n", "must not touch the file when a port is already set");
});

test("ensure-port rejects an out-of-range port", async () => {
  const res = await fetch(`${base}/webgui/${INSTANCE}/ensure-port`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ port: 99999 }),
  });
  assert.equal(res.status, 400);
});

// ---- webgui relay ----

test("relay falls back to the DCS default port (8088) when nothing's configured", async () => {
  const dummyDcs = await new Promise((resolve) => {
    const s = require("node:http").createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: req.url }));
    });
    s.listen(8088, "127.0.0.1", () => resolve(s));
  });
  try {
    const instance = "Example_NoPortSet";
    fs.mkdirSync(instanceDir(instance), { recursive: true });
    const res = await fetch(`${base}/webgui/${instance}/some/path`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.path, "/some/path");
  } finally {
    dummyDcs.close();
  }
});

test("relay uses the configured port and strips the /webgui/<instance> prefix", async () => {
  const dummyDcs = await new Promise((resolve) => {
    const s = require("node:http").createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: req.url }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const port = dummyDcs.address().port;
    const instance = "Example_CustomPort";
    fs.mkdirSync(path.join(instanceDir(instance), "Config"), { recursive: true });
    fs.writeFileSync(path.join(instanceDir(instance), "Config", "autoexec.cfg"), `webgui_port = ${port}\n`);

    const res = await fetch(`${base}/webgui/${instance}/encryptedRequest?x=1`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.path, "/encryptedRequest?x=1");
  } finally {
    dummyDcs.close();
  }
});

test("relay rejects requests with no token", async () => {
  const res = await fetch(`${base}/webgui/${INSTANCE}/some/path`);
  assert.equal(res.status, 401);
});

// ---- dcs install webgui bundle ----

test("webgui-bundle rejects requests with no token", async () => {
  const res = await fetch(`${base}/dcs-install/webgui-bundle?path=${encodeURIComponent(dcsInstallRoot)}`);
  assert.equal(res.status, 401);
});

test("webgui-bundle rejects a missing path query parameter", async () => {
  const res = await fetch(`${base}/dcs-install/webgui-bundle`, { headers: authHeaders() });
  assert.equal(res.status, 400);
});

test("webgui-bundle 404s when the install path has no WebGUI folder", async () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mission-agent-empty-install-"));
  try {
    const res = await fetch(`${base}/dcs-install/webgui-bundle?path=${encodeURIComponent(emptyRoot)}`, {
      headers: authHeaders(),
    });
    assert.equal(res.status, 404);
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test("webgui-bundle streams a tar of the real WebGUI folder", async () => {
  const res = await fetch(`${base}/dcs-install/webgui-bundle?path=${encodeURIComponent(dcsInstallRoot)}`, {
    headers: authHeaders(),
  });
  assert.equal(res.status, 200);

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-agent-bundle-extract-"));
  try {
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(extractDir, "bundle.tar"), buffer);
    await tar.x({ file: path.join(extractDir, "bundle.tar"), cwd: extractDir });

    assert.equal(fs.readFileSync(path.join(extractDir, "index.html"), "utf8"), "<html>real dcs webgui</html>");
    assert.equal(fs.readFileSync(path.join(extractDir, "js", "app.js"), "utf8"), "console.log('app');");
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
});
