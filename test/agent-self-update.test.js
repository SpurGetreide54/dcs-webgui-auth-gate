const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const TOKEN = "agent-self-update-test-token";
const savedGamesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-self-update-saved-games-"));
const selfUpdateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-self-update-root-"));

process.env.AGENT_PORT = "0";
process.env.MISSION_AGENT_TOKEN = TOKEN;
process.env.DCS_SAVED_GAMES_ROOT = savedGamesRoot;
process.env.AGENT_SELF_UPDATE_ROOT = selfUpdateRoot;
// Without this, a successful /self-update/commit call kills this test
// file's own process -- see agent.js's commit handler.
process.env.AGENT_SELF_UPDATE_SKIP_EXIT = "1";

const app = require("../src/agent");

let server, base;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(savedGamesRoot, { recursive: true, force: true });
  fs.rmSync(selfUpdateRoot, { recursive: true, force: true });
});

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

test("stage rejects requests with no token", async () => {
  const body = Buffer.from("fake exe bytes");
  const res = await fetch(`${base}/self-update/stage`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Sha256": sha256(body) },
    body,
  });
  assert.equal(res.status, 401);
});

test("stage rejects a body whose sha256 doesn't match the X-Sha256 header", async () => {
  const body = Buffer.from("fake exe bytes");
  const res = await fetch(`${base}/self-update/stage`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/octet-stream", "X-Sha256": "a".repeat(64) }),
    body,
  });
  assert.equal(res.status, 400);
});

// Runs before anything has been staged -- order matters here, since
// AGENT_SELF_UPDATE_ROOT is read once at module load and can't be swapped
// per test, so this is the one point where "nothing staged yet" is true.
test("commit rejects when nothing has been staged in the idle slot", async () => {
  const res = await fetch(`${base}/self-update/commit`, { method: "POST", headers: authHeaders() });
  assert.equal(res.status, 400);
});

test("stage writes the exe into the idle slot (not the active one)", async () => {
  // Nothing active yet -- readActiveAgentSlot() defaults to "a" when no
  // "current" junction exists, so the idle slot is "b".
  const body = Buffer.from("fresh build bytes");
  const res = await fetch(`${base}/self-update/stage`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/octet-stream", "X-Sha256": sha256(body) }),
    body,
  });
  assert.equal(res.status, 200);
  const stageBody = await res.json();
  assert.equal(stageBody.slot, "b");
  const staged = fs.readFileSync(path.join(selfUpdateRoot, "releases", "b", "agent.exe"));
  assert.deepEqual(staged, body);
});

test("commit flips the current junction to the staged (idle) slot", async () => {
  const res = await fetch(`${base}/self-update/commit`, { method: "POST", headers: authHeaders() });
  // The process deliberately exits right after responding (see agent.js),
  // so the response itself is the only thing to check here -- by the time
  // this resolves, the process may already be mid-exit.
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.activeSlot, "b");

  const linkTarget = fs.readlinkSync(path.join(selfUpdateRoot, "current"));
  assert.equal(path.basename(linkTarget), "b");
});

test("commit rejects requests with no token", async () => {
  const res = await fetch(`${base}/self-update/commit`, { method: "POST" });
  assert.equal(res.status, 401);
});
