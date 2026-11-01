const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");

const tar = require("tar");

const TOKEN = "agent-test-token";
const savedGamesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mission-agent-test-"));
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-agent-outside-"));
const dcsInstallRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mission-agent-dcs-install-"));
const agentLogFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mission-agent-log-")), "agent.log");

process.env.AGENT_PORT = "0";
process.env.MISSION_AGENT_TOKEN = TOKEN;
process.env.DCS_SAVED_GAMES_ROOT = savedGamesRoot;
process.env.AGENT_LOG_FILE = agentLogFile;

const app = require("../src/agent");

let server, base;
const INSTANCE = "Example_Training";

// a given instance's own directory under the fake saved games root
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

// a fake multipart upload body for the /upload tests below
function uploadForm(filename, instanceName) {
  const form = new FormData();
  form.append("instance_name", instanceName);
  form.append("mission", new Blob([Buffer.from("fake miz contents")]), filename);
  return form;
}

// the bearer header every authenticated request below needs
function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

// section: upload

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

test("writes a non-ASCII .miz filename to disk unmangled", async () => {
  const name = "Übung_Überflug.miz";
  const res = await fetch(`${base}/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: uploadForm(name, INSTANCE),
  });
  assert.equal(res.status, 200);
  const written = fs.readdirSync(path.join(instanceDir(), "Missions"));
  assert.ok(written.includes(name), `expected "${name}" on disk, got: ${written.join(", ")}`);
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
  // whatever status it returns, the decisive check is that nothing landed outside the instance dir
  assert.ok(res.status === 400 || res.status === 200, `unexpected status ${res.status}`);
  assert.equal(fs.existsSync(path.join(outsideDir, "passwd.miz")), false);
  const escapedPath = path.resolve(instanceDir(), "Missions", "..", "..", "..", "etc", "passwd.miz");
  assert.equal(fs.existsSync(escapedPath), false, "path traversal must not escape the instance folder");
});

test("rejects a non-string instance_name, and the agent survives the attempt", async () => {
  // a repeated form field is how multer turns instance_name into an
  // array, the same shape a crafted request would use
  const form = new FormData();
  form.append("instance_name", "first");
  form.append("instance_name", "second");
  form.append("mission", new Blob([Buffer.from("fake miz contents")]), "m.miz");

  const res = await fetch(`${base}/upload`, { method: "POST", headers: authHeaders(), body: form });
  assert.equal(res.status, 400);

  const stillUp = await fetch(`${base}/missions/${INSTANCE}`, { headers: authHeaders() });
  assert.equal(stillUp.status, 200);
});

test("rejects non-.miz files", async () => {
  const res = await fetch(`${base}/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: uploadForm("not-a-mission.txt", INSTANCE),
  });
  assert.equal(res.status, 400);
});

// section: webgui control port, status + ensure-port

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

// exact bytes from a real production autoexec.cfg, confirming the
// regex against a genuine dcs-authored shape, not just a synthetic one
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

test("status ignores a commented-out webgui_port line", async () => {
  const instance = "Example_CommentedPort";
  fs.mkdirSync(path.join(instanceDir(instance), "Config"), { recursive: true });
  fs.writeFileSync(path.join(instanceDir(instance), "Config", "autoexec.cfg"), "-- webgui_port = 8088\n");

  const res = await fetch(`${base}/webgui/${instance}/status`, { headers: authHeaders() });
  const body = await res.json();
  assert.deepEqual(body, { configExists: true, webguiPort: null });
});

test("status takes the last webgui_port assignment when several exist", async () => {
  const instance = "Example_MultipleAssignments";
  fs.mkdirSync(path.join(instanceDir(instance), "Config"), { recursive: true });
  fs.writeFileSync(path.join(instanceDir(instance), "Config", "autoexec.cfg"), "webgui_port = 8080\nwebgui_port = 8081\n");

  const res = await fetch(`${base}/webgui/${instance}/status`, { headers: authHeaders() });
  const body = await res.json();
  assert.deepEqual(body, { configExists: true, webguiPort: 8081 }, "lua evaluates repeated assignments in order, last one wins");
});

test("ensure-port then status round-trips the same port", async () => {
  const instance = "Example_RoundTrip";
  fs.mkdirSync(instanceDir(instance), { recursive: true });

  await fetch(`${base}/webgui/${instance}/ensure-port`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ port: 8095 }),
  });
  const res = await fetch(`${base}/webgui/${instance}/status`, { headers: authHeaders() });
  const body = await res.json();
  assert.deepEqual(body, { configExists: true, webguiPort: 8095 });
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
  // ".." itself gets collapsed by url normalization before the request
  // is even sent, so this uses a value that survives normalization intact
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

// section: webgui relay

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

test("relay strips the agent's own bearer token, cookie, and origin before reaching DCS", async () => {
  let lastDcsRequestHeaders;
  const dummyDcs = await new Promise((resolve) => {
    const s = require("node:http").createServer((req, res) => {
      lastDcsRequestHeaders = req.headers;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: req.url }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const port = dummyDcs.address().port;
    const instance = "Example_HeaderScrub";
    fs.mkdirSync(path.join(instanceDir(instance), "Config"), { recursive: true });
    fs.writeFileSync(path.join(instanceDir(instance), "Config", "autoexec.cfg"), `webgui_port = ${port}\n`);

    await fetch(`${base}/webgui/${instance}/some/path`, {
      headers: authHeaders({ Cookie: "dcs_session=leaked-session-value", Origin: "http://evil.example" }),
    });
    assert.equal(lastDcsRequestHeaders.authorization, undefined, "the agent's own bearer token must not reach DCS");
    assert.equal(lastDcsRequestHeaders.cookie, undefined, "the gate's session cookie must not reach DCS");
    assert.equal(lastDcsRequestHeaders.origin, undefined, "the browser's own origin must not reach DCS");
  } finally {
    dummyDcs.close();
  }
});

test("relay: a websocket upgrade request is treated as an ordinary one, not routed to a crashing handler", async () => {
  const dummyDcs = await new Promise((resolve) => {
    const s = require("node:http").createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: req.url }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const port = dummyDcs.address().port;
    const instance = "Example_UpgradeRequest";
    fs.mkdirSync(path.join(instanceDir(instance), "Config"), { recursive: true });
    fs.writeFileSync(path.join(instanceDir(instance), "Config", "autoexec.cfg"), `webgui_port = ${port}\n`);

    const http = require("node:http");
    const upgradeStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path: `/webgui/${instance}/some/path`,
          headers: { Authorization: `Bearer ${TOKEN}`, Connection: "Upgrade", Upgrade: "websocket" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on("upgrade", (res) => resolve(`upgrade:${res.statusCode}`));
      req.on("error", reject);
      req.end();
    });
    assert.equal(upgradeStatus, 200, "with no upgrade listener attached, the request must be handled as an ordinary one");

    const plainRes = await fetch(`${base}/webgui/${instance}/some/path`, { headers: authHeaders() });
    assert.equal(plainRes.status, 200, "the server must still answer normal requests afterward");
  } finally {
    dummyDcs.close();
  }
});

test("relay rejects requests with no token", async () => {
  const res = await fetch(`${base}/webgui/${INSTANCE}/some/path`);
  assert.equal(res.status, 401);
});

// section: dcs install webgui bundle

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

// section: mission list

test("list is empty when the Missions folder doesn't exist yet", async () => {
  const instance = "Example_NoMissionsYet";
  fs.mkdirSync(instanceDir(instance), { recursive: true });
  const res = await fetch(`${base}/missions/${instance}`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { missions: [] });
});

test("list returns .miz files with name/size/mtime, excluding non-.miz files", async () => {
  const instance = "Example_MissionsList";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  fs.writeFileSync(path.join(missionsDir, "one.miz"), "fake miz one");
  fs.writeFileSync(path.join(missionsDir, "readme.txt"), "not a mission");

  const res = await fetch(`${base}/missions/${instance}`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.missions.length, 1);
  assert.equal(body.missions[0].name, "one.miz");
  assert.equal(body.missions[0].size, "fake miz one".length);
  assert.ok(new Date(body.missions[0].modifiedAt).getTime() > 0, "modifiedAt must be a real timestamp");
});

test("list rejects requests with no token", async () => {
  const res = await fetch(`${base}/missions/${INSTANCE}`);
  assert.equal(res.status, 401);
});

test("list: an error thrown inside the async handler returns 500, and the agent survives it", async (t) => {
  const instance = "Example_ListCrash";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  fs.writeFileSync(path.join(missionsDir, "one.miz"), "fake miz one");

  // see docs/Why.md#why-does-every-async-handler-need-asynchandler
  t.mock.method(fsp, "stat", () => {
    throw new Error("simulated crash inside an async handler");
  });
  const crashRes = await fetch(`${base}/missions/${instance}`, { headers: authHeaders() });
  assert.equal(crashRes.status, 500, "a thrown error inside an async handler must return 500, not crash the process");
  t.mock.reset();

  const stillUp = await fetch(`${base}/missions/${instance}`, { headers: authHeaders() });
  assert.equal(stillUp.status, 200, "the next request after a caught crash must still succeed, the process must still be alive");
});

// section: mission download

test("download of a single selected mission streams the raw .miz back unmodified", async () => {
  const instance = "Example_DownloadSingle";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  fs.writeFileSync(path.join(missionsDir, "solo.miz"), "solo mission bytes");

  const res = await fetch(`${base}/missions/${instance}/download`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["solo.miz"] }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") || "", /filename="solo\.miz"/);
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.toString("utf8"), "solo mission bytes", "a single selection must come back byte-for-byte, not re-wrapped in another zip");
});

test("download: aborting the client mid-stream destroys the server-side file handle instead of leaking it", async () => {
  const instance = "Example_DownloadAbort";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  // large enough that the first chunk arrives well before the whole
  // file would finish streaming, giving room to abort mid-transfer
  fs.writeFileSync(path.join(missionsDir, "big.miz"), crypto.randomBytes(5 * 1024 * 1024));

  const originalCreateReadStream = fs.createReadStream;
  let capturedStream;
  fs.createReadStream = function (...args) {
    capturedStream = originalCreateReadStream.apply(fs, args);
    return capturedStream;
  };

  try {
    const http = require("node:http");
    const body = JSON.stringify({ missions: ["big.miz"] });
    await new Promise((resolve, reject) => {
      const req = http.request(
        `${base}/missions/${instance}/download`,
        { method: "POST", headers: authHeaders({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }) },
        (res) => {
          res.once("data", () => {
            // the client walks away mid-transfer, never reading the rest
            req.destroy();
          });
        }
      );
      req.on("error", resolve); // destroying our own request is expected to surface as an error here
      req.write(body);
      req.end();
      setTimeout(resolve, 200);
    });

    assert.ok(capturedStream, "the download route must have opened a read stream");
    assert.ok(capturedStream.destroyed, "the server-side read stream must be destroyed once the client aborts, not left open");
  } finally {
    fs.createReadStream = originalCreateReadStream;
  }
});

test("download Content-Disposition carries an ascii fallback and the real UTF-8 name", async () => {
  const instance = "Example_DownloadUnicodeName";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  const name = "Red Flag ü.miz";
  fs.writeFileSync(path.join(missionsDir, name), "unicode-named mission bytes");

  const res = await fetch(`${base}/missions/${instance}/download`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: [name] }),
  });
  assert.equal(res.status, 200);
  const disposition = res.headers.get("content-disposition") || "";
  assert.match(disposition, /filename="Red Flag _\.miz"/, "the ascii fallback must keep the space and replace the non-ascii character");
  assert.match(disposition, new RegExp(`filename\\*=UTF-8''${encodeURIComponent(name)}`), "the extended value must carry the real name, percent-encoded");
});

test("download of multiple selected missions bundles them into one zip", async () => {
  const instance = "Example_DownloadMulti";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  fs.writeFileSync(path.join(missionsDir, "alpha.miz"), "alpha bytes");
  fs.writeFileSync(path.join(missionsDir, "bravo.miz"), "bravo bytes");

  const res = await fetch(`${base}/missions/${instance}/download`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["alpha.miz", "bravo.miz"] }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") || "", /filename="missions\.zip"/);
  const body = Buffer.from(await res.arrayBuffer());
  // stored (uncompressed) entries, so both filename and content
  // survive as literal bytes, no zip-reading library needed to check
  assert.ok(body.includes("alpha.miz"), "zip must contain alpha.miz's name");
  assert.ok(body.includes("alpha bytes"), "zip must contain alpha.miz's content");
  assert.ok(body.includes("bravo.miz"), "zip must contain bravo.miz's name");
  assert.ok(body.includes("bravo bytes"), "zip must contain bravo.miz's content");
});

test("download rejects an unknown mission name", async () => {
  const res = await fetch(`${base}/missions/${INSTANCE}/download`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["does-not-exist.miz"] }),
  });
  assert.equal(res.status, 404);
});

// path.basename() reduces the traversal to a plain filename first,
// so 404 (no such mission) is the correct, safe outcome, not 400;
// a name distinct from the upload traversal test's own "passwd.miz"
// leftover, so this doesn't accidentally find a real file
test("download: a path-traversal mission name reduces to a plain filename and 404s, never escapes the folder", async () => {
  const res = await fetch(`${base}/missions/${INSTANCE}/download`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["../../../etc/download-traversal-probe.miz"] }),
  });
  assert.equal(res.status, 404);
});

test("download rejects a dot-led or empty mission name, and the agent survives the attempt", async () => {
  for (const name of [".", "", "..", ".trash", ".hidden.miz"]) {
    const res = await fetch(`${base}/missions/${INSTANCE}/download`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ missions: [name] }),
    });
    assert.equal(res.status, 400, `${JSON.stringify(name)} must be rejected before it can resolve to the Missions folder itself`);
  }

  // proves the process is still alive, not just that each fetch above
  // returned without the connection dropping
  const stillUp = await fetch(`${base}/missions/${INSTANCE}`, { headers: authHeaders() });
  assert.equal(stillUp.status, 200);
});

test("download rejects a non-string mission name, and the agent survives the attempt", async () => {
  for (const name of [{ a: 1 }, 42, null, ["nested"]]) {
    const res = await fetch(`${base}/missions/${INSTANCE}/download`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ missions: [name] }),
    });
    assert.equal(res.status, 400, `${JSON.stringify(name)} must be rejected before it reaches path.basename`);
  }

  const stillUp = await fetch(`${base}/missions/${INSTANCE}`, { headers: authHeaders() });
  assert.equal(stillUp.status, 200);
});

test("download rejects a non-.miz file in Missions/, not just .miz ones", async () => {
  const instance = "Example_DownloadNonMiz";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  fs.writeFileSync(path.join(missionsDir, "notes.lua"), "not a mission");

  const res = await fetch(`${base}/missions/${instance}/download`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["notes.lua"] }),
  });
  assert.equal(res.status, 400);
});

test("trash rejects a non-.miz file in Missions/, not just .miz ones", async () => {
  const instance = "Example_TrashNonMiz";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  fs.writeFileSync(path.join(missionsDir, "notes.lua"), "not a mission");

  const res = await fetch(`${base}/missions/${instance}/trash`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["notes.lua"] }),
  });
  assert.equal(res.status, 400);
  assert.equal(fs.existsSync(path.join(missionsDir, "notes.lua")), true, "a rejected non-.miz file must be left in place, not moved aside");
});

test("restore rejects a hand-placed trash entry whose original name wasn't .miz", async () => {
  const instance = "Example_RestoreNonMiz";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  const trashDir = path.join(missionsDir, ".trash");
  fs.mkdirSync(trashDir, { recursive: true });
  fs.writeFileSync(path.join(trashDir, "notes.txt.1700000000000"), "not a mission");

  const res = await fetch(`${base}/missions/${instance}/trash/restore`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ trash: ["notes.txt.1700000000000"] }),
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Unrecognized trash entry/);
});

test("download 404s on a real subdirectory instead of streaming it", async () => {
  const instance = "Example_SubdirDownload";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  // named like a mission so this test exercises the directory check
  // itself, not the separate .miz-extension gate
  fs.mkdirSync(path.join(missionsDir, "a-subdir.miz"), { recursive: true });

  const res = await fetch(`${base}/missions/${instance}/download`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["a-subdir.miz"] }),
  });
  assert.equal(res.status, 404);

  const stillUp = await fetch(`${base}/missions/${instance}`, { headers: authHeaders() });
  assert.equal(stillUp.status, 200);
});

// section: mission soft-delete (trash)

test("trash moves the mission aside instead of deleting it", async () => {
  const instance = "Example_Trash";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  fs.writeFileSync(path.join(missionsDir, "unwanted.miz"), "unwanted bytes");

  const res = await fetch(`${base}/missions/${instance}/trash`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["unwanted.miz"] }),
  });
  assert.equal(res.status, 200);
  assert.equal(fs.existsSync(path.join(missionsDir, "unwanted.miz")), false, "must no longer be in Missions/ under its original name");

  const trashDir = path.join(missionsDir, ".trash");
  const trashed = fs.readdirSync(trashDir).filter((name) => name.startsWith("unwanted.miz"));
  assert.equal(trashed.length, 1, "the file must survive, moved aside into .trash/, not unlinked");
  assert.equal(fs.readFileSync(path.join(trashDir, trashed[0]), "utf8"), "unwanted bytes");
});

test("trash moves multiple selected missions aside in one request", async () => {
  const instance = "Example_TrashMulti";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  fs.writeFileSync(path.join(missionsDir, "keep.miz"), "keep bytes");
  fs.writeFileSync(path.join(missionsDir, "gone-one.miz"), "gone one bytes");
  fs.writeFileSync(path.join(missionsDir, "gone-two.miz"), "gone two bytes");

  const res = await fetch(`${base}/missions/${instance}/trash`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["gone-one.miz", "gone-two.miz"] }),
  });
  assert.equal(res.status, 200);
  assert.equal(fs.existsSync(path.join(missionsDir, "gone-one.miz")), false);
  assert.equal(fs.existsSync(path.join(missionsDir, "gone-two.miz")), false);
  assert.equal(fs.existsSync(path.join(missionsDir, "keep.miz")), true, "a mission not selected for delete must be left alone");
});

test("trash dedupes a repeated name in one request instead of failing on the second rename", async () => {
  const instance = "Example_TrashDuplicateName";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  fs.writeFileSync(path.join(missionsDir, "dupe.miz"), "dupe bytes");

  const res = await fetch(`${base}/missions/${instance}/trash`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["dupe.miz", "dupe.miz"] }),
  });
  assert.equal(res.status, 200);
  const trashDir = path.join(missionsDir, ".trash");
  const trashed = fs.readdirSync(trashDir).filter((name) => name.startsWith("dupe.miz"));
  assert.equal(trashed.length, 1, "a name repeated in one request must be trashed once, not attempted twice");
});

test("trash bumps the millisecond suffix on a same-millisecond collision instead of overwriting the earlier entry", async () => {
  const instance = "Example_TrashCollision";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  const trashDir = path.join(missionsDir, ".trash");
  fs.mkdirSync(missionsDir, { recursive: true });
  fs.mkdirSync(trashDir, { recursive: true });

  // simulate an already-trashed entry landing on "now", the same
  // millisecond the real trash call below will also compute
  const now = Date.now();
  fs.writeFileSync(path.join(trashDir, `collide.miz.${now}`), "first trashed bytes");

  fs.writeFileSync(path.join(missionsDir, "collide.miz"), "second trashed bytes");
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const res = await fetch(`${base}/missions/${instance}/trash`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ missions: ["collide.miz"] }),
    });
    assert.equal(res.status, 200);
  } finally {
    Date.now = originalNow;
  }

  const trashed = fs.readdirSync(trashDir).filter((name) => name.startsWith("collide.miz"));
  assert.equal(trashed.length, 2, "both trash entries must survive, under distinct names");
  const contents = trashed.map((name) => fs.readFileSync(path.join(trashDir, name), "utf8"));
  assert.ok(contents.includes("first trashed bytes"), "the earlier trash entry must not be overwritten");
  assert.ok(contents.includes("second trashed bytes"));
});

test("trash rejects an unknown mission name", async () => {
  const res = await fetch(`${base}/missions/${INSTANCE}/trash`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["does-not-exist.miz"] }),
  });
  assert.equal(res.status, 404);
});

// same basename-neutralizes-it-first reasoning as the download test
// above, and the same reason for a distinct, non-colliding name
test("trash: a path-traversal mission name reduces to a plain filename and 404s, never escapes the folder", async () => {
  const res = await fetch(`${base}/missions/${INSTANCE}/trash`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["../../../etc/trash-traversal-probe.miz"] }),
  });
  assert.equal(res.status, 404);
});

test("trash rejects a dot-led or empty mission name, and the agent survives the attempt", async () => {
  for (const name of [".", "", "..", ".trash", ".hidden.miz"]) {
    const res = await fetch(`${base}/missions/${INSTANCE}/trash`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ missions: [name] }),
    });
    assert.equal(res.status, 400, `${JSON.stringify(name)} must be rejected before any file in the request is moved`);
  }

  const stillUp = await fetch(`${base}/missions/${INSTANCE}`, { headers: authHeaders() });
  assert.equal(stillUp.status, 200);
});

test("trash rejects a non-string mission name, and the agent survives the attempt", async () => {
  for (const name of [{ a: 1 }, 42, null, ["nested"]]) {
    const res = await fetch(`${base}/missions/${INSTANCE}/trash`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ missions: [name] }),
    });
    assert.equal(res.status, 400, `${JSON.stringify(name)} must be rejected before it reaches path.basename`);
  }

  const stillUp = await fetch(`${base}/missions/${INSTANCE}`, { headers: authHeaders() });
  assert.equal(stillUp.status, 200);
});

test("trash 404s on a real subdirectory instead of renaming it into itself", async () => {
  const instance = "Example_SubdirTrash";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  // named like a mission so this test exercises the directory check
  // itself, not the separate .miz-extension gate
  fs.mkdirSync(path.join(missionsDir, "a-subdir.miz"), { recursive: true });

  const res = await fetch(`${base}/missions/${instance}/trash`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["a-subdir.miz"] }),
  });
  assert.equal(res.status, 404);
  assert.equal(fs.existsSync(path.join(missionsDir, "a-subdir.miz")), true, "the subdirectory must be left untouched");

  const stillUp = await fetch(`${base}/missions/${instance}`, { headers: authHeaders() });
  assert.equal(stillUp.status, 200);
});

// section: trash listing and restore

test("trash listing is empty before anything is trashed, and parses name/size/trashedAt after", async () => {
  const instance = "Example_TrashList";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  fs.mkdirSync(missionsDir, { recursive: true });

  const emptyRes = await fetch(`${base}/missions/${instance}/trash`, { headers: authHeaders() });
  assert.equal(emptyRes.status, 200);
  assert.deepEqual(await emptyRes.json(), { trash: [] }, "no .trash dir yet must list as empty, not 404 or 500");

  fs.writeFileSync(path.join(missionsDir, "listed.miz"), "listed bytes");
  const trashRes = await fetch(`${base}/missions/${instance}/trash`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["listed.miz"] }),
  });
  assert.equal(trashRes.status, 200);

  const listRes = await fetch(`${base}/missions/${instance}/trash`, { headers: authHeaders() });
  const { trash } = await listRes.json();
  assert.equal(trash.length, 1);
  assert.equal(trash[0].name, "listed.miz", "the original name must survive, stripped of its trailing .<timestamp>");
  assert.equal(trash[0].size, Buffer.byteLength("listed bytes"));
  assert.match(trash[0].trashedAt, /^\d{4}-\d{2}-\d{2}T/, "trashedAt must be a real ISO timestamp, parsed from Date.now()");
  assert.match(trash[0].trashName, /^listed\.miz\.\d+$/, "trashName is the real on-disk name, needed to restore this exact entry");
});

test("trash listing skips a hand-placed entry with an out-of-range numeric suffix instead of 500ing", async () => {
  const instance = "Example_TrashHugeSuffix";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  const trashDir = path.join(missionsDir, ".trash");
  fs.mkdirSync(trashDir, { recursive: true });
  // beyond Date's +-8.64e15 range, new Date(Number(...)) is Invalid Date
  fs.writeFileSync(path.join(trashDir, "bad.miz.99999999999999999999"), "bad bytes");
  fs.writeFileSync(path.join(trashDir, "good.miz.1700000000000"), "good bytes");

  const listRes = await fetch(`${base}/missions/${instance}/trash`, { headers: authHeaders() });
  assert.equal(listRes.status, 200, "an unparseable entry must not 500 the whole listing");
  const { trash } = await listRes.json();
  assert.equal(trash.length, 1, "only the normal entry must be listed, the unparseable one skipped");
  assert.equal(trash[0].name, "good.miz");

  const restoreRes = await fetch(`${base}/missions/${instance}/trash/restore`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ trash: ["bad.miz.99999999999999999999"] }),
  });
  assert.equal(restoreRes.status, 400, "restoring the unparseable entry must 400, not 500");
  assert.match(await restoreRes.text(), /Unrecognized trash entry/);
});

test("restore moves a trashed mission back into Missions/ under its original name", async () => {
  const instance = "Example_TrashRestore";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  fs.writeFileSync(path.join(missionsDir, "comeback.miz"), "comeback bytes");

  await fetch(`${base}/missions/${instance}/trash`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["comeback.miz"] }),
  });
  const { trash } = await (await fetch(`${base}/missions/${instance}/trash`, { headers: authHeaders() })).json();
  assert.equal(trash.length, 1);

  const restoreRes = await fetch(`${base}/missions/${instance}/trash/restore`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ trash: [trash[0].trashName] }),
  });
  assert.equal(restoreRes.status, 200);
  const restoreBody = await restoreRes.json();
  assert.deepEqual(restoreBody.restored, ["comeback.miz"]);
  assert.equal(fs.readFileSync(path.join(missionsDir, "comeback.miz"), "utf8"), "comeback bytes");
  assert.equal(fs.existsSync(path.join(missionsDir, ".trash", trash[0].trashName)), false, "must no longer be in .trash/ after restoring");
});

test("restore refuses to overwrite a mission that already exists under that name", async () => {
  const instance = "Example_TrashRestoreConflict";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  fs.writeFileSync(path.join(missionsDir, "clash.miz"), "original bytes");
  await fetch(`${base}/missions/${instance}/trash`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["clash.miz"] }),
  });
  // a new mission uploaded back under the same name after trashing
  fs.writeFileSync(path.join(missionsDir, "clash.miz"), "newer bytes");
  const { trash } = await (await fetch(`${base}/missions/${instance}/trash`, { headers: authHeaders() })).json();

  const restoreRes = await fetch(`${base}/missions/${instance}/trash/restore`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ trash: [trash[0].trashName] }),
  });
  assert.equal(restoreRes.status, 409);
  assert.equal(fs.readFileSync(path.join(missionsDir, "clash.miz"), "utf8"), "newer bytes", "the existing mission must survive untouched");
  assert.equal(fs.existsSync(path.join(missionsDir, ".trash", trash[0].trashName)), true, "the trashed copy must stay in .trash/, not be lost");
});

test("restore refuses a batch that would restore two trashed entries to the same name", async () => {
  const instance = "Example_TrashRestoreDupBatch";
  const missionsDir = path.join(instanceDir(instance), "Missions");
  fs.mkdirSync(missionsDir, { recursive: true });
  fs.writeFileSync(path.join(missionsDir, "twice.miz"), "first version");
  await fetch(`${base}/missions/${instance}/trash`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["twice.miz"] }),
  });
  fs.writeFileSync(path.join(missionsDir, "twice.miz"), "second version");
  await fetch(`${base}/missions/${instance}/trash`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ missions: ["twice.miz"] }),
  });
  const { trash } = await (await fetch(`${base}/missions/${instance}/trash`, { headers: authHeaders() })).json();
  assert.equal(trash.length, 2, "both trashed copies of the same original name must be listed separately");

  const restoreRes = await fetch(`${base}/missions/${instance}/trash/restore`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ trash: trash.map((t) => t.trashName) }),
  });
  assert.equal(restoreRes.status, 409, "restoring both at once would silently overwrite one with the other");
  for (const entry of trash) {
    assert.equal(fs.existsSync(path.join(missionsDir, ".trash", entry.trashName)), true, "neither trashed copy must be moved when the batch is refused");
  }
});

test("restore rejects an unknown or invalid trash entry, and the agent survives the attempt", async () => {
  for (const name of ["does-not-exist.miz.123", ".", "", "../../etc/passwd"]) {
    const res = await fetch(`${base}/missions/${INSTANCE}/trash/restore`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ trash: [name] }),
    });
    assert.ok([400, 404].includes(res.status), `${JSON.stringify(name)} must be rejected, not crash the agent`);
  }
  const stillUp = await fetch(`${base}/missions/${INSTANCE}`, { headers: authHeaders() });
  assert.equal(stillUp.status, 200);
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

test("installConsoleCapture formats console.log as NDJSON", () => {
  // console.log is already the wrapped version, installed automatically
  // when this file required ../src/agent, so spying on stdout directly
  // is what actually sees what the wrapper emits
  const originalWrite = process.stdout.write;
  let captured = "";
  process.stdout.write = (chunk) => {
    captured += chunk;
    return true;
  };
  try {
    console.log("hello", 1);
  } finally {
    process.stdout.write = originalWrite;
  }
  const parsed = JSON.parse(captured.trim());
  assert.equal(parsed.level, "log");
  assert.equal(parsed.msg, "hello 1");
  assert.match(parsed.t, /^\d{4}-\d{2}-\d{2}T/, "needs a real ISO timestamp");
});

test("installConsoleCapture formats console.debug as NDJSON with level 'debug'", () => {
  const originalWrite = process.stdout.write;
  let captured = "";
  process.stdout.write = (chunk) => {
    captured += chunk;
    return true;
  };
  try {
    console.debug("step 1 of 3");
  } finally {
    process.stdout.write = originalWrite;
  }
  const parsed = JSON.parse(captured.trim());
  assert.equal(parsed.level, "debug");
  assert.equal(parsed.msg, "step 1 of 3");
});

test("logs rejects requests with no token", async () => {
  const res = await fetch(`${base}/logs`);
  assert.equal(res.status, 401);
});

test("logs returns empty text when AGENT_LOG_FILE doesn't exist yet", async () => {
  fs.rmSync(agentLogFile, { force: true });
  const res = await fetch(`${base}/logs`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
});

test("logs returns the tail of AGENT_LOG_FILE", async () => {
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(JSON.stringify({ t: new Date().toISOString(), level: "log", msg: `line ${i}` }));
  fs.writeFileSync(agentLogFile, lines.join("\n") + "\n");

  const res = await fetch(`${base}/logs`, { headers: authHeaders() });
  assert.equal(res.status, 200);
  const got = (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).msg);
  assert.deepEqual(got, ["line 0", "line 1", "line 2", "line 3", "line 4"]);
});
