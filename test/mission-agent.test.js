const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const TOKEN = "agent-test-token";
const missionDir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-agent-test-"));
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-agent-outside-"));

process.env.AGENT_PORT = "0";
process.env.MISSION_AGENT_TOKEN = TOKEN;
process.env.MISSION_FOLDER_TRAINING = missionDir;
process.env.MISSION_FOLDER_COMMUNITY1 = missionDir;
process.env.MISSION_FOLDER_COMMUNITY2 = missionDir;

const app = require("../src/agent");

let server, base;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(missionDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

function uploadForm(filename, folderKey) {
  const form = new FormData();
  form.append("folder_key", folderKey);
  form.append("mission", new Blob([Buffer.from("fake miz contents")]), filename);
  return form;
}

test("rejects requests with no token", async () => {
  const res = await fetch(`${base}/upload`, { method: "POST", body: uploadForm("m.miz", "training") });
  assert.equal(res.status, 401);
});

test("rejects requests with the wrong token", async () => {
  const res = await fetch(`${base}/upload`, {
    method: "POST",
    headers: { Authorization: "Bearer wrong-token" },
    body: uploadForm("m.miz", "training"),
  });
  assert.equal(res.status, 401);
});

test("writes a valid .miz upload into the configured folder", async () => {
  const res = await fetch(`${base}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: uploadForm("real-mission.miz", "training"),
  });
  assert.equal(res.status, 200);
  const written = fs.readFileSync(path.join(missionDir, "real-mission.miz"), "utf8");
  assert.equal(written, "fake miz contents");
});

test("rejects an unknown folder_key", async () => {
  const res = await fetch(`${base}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: uploadForm("m.miz", "not-a-real-server"),
  });
  assert.equal(res.status, 400);
});

test("rejects a path-traversal filename instead of escaping the mission folder", async () => {
  const res = await fetch(`${base}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: uploadForm("../../../etc/passwd.miz", "training"),
  });
  // Whatever status it returns, the decisive check is that nothing landed outside missionDir.
  assert.ok(res.status === 400 || res.status === 200, `unexpected status ${res.status}`);
  assert.equal(fs.existsSync(path.join(outsideDir, "passwd.miz")), false);
  const escapedPath = path.resolve(missionDir, "..", "..", "..", "etc", "passwd.miz");
  assert.equal(fs.existsSync(escapedPath), false, "path traversal must not escape the mission folder");
});

test("rejects non-.miz files", async () => {
  const res = await fetch(`${base}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: uploadForm("not-a-mission.txt", "training"),
  });
  assert.equal(res.status, 400);
});
