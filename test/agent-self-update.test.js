const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");

const TOKEN = "agent-self-update-test-token";
const savedGamesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-self-update-saved-games-"));
const selfUpdateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-self-update-root-"));
const keyStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-self-update-key-state-"));
const keyStateFile = path.join(keyStateDir, "agent-key-state.json");

// a throwaway keypair, pre-seeded into AGENT_KEY_STATE_FILE below so
// the agent trusts it instead of the real baked-in constants -- real
// local-only/keys/ material would also work, but it's shared, mutable
// state other test files rotate for real, racy under this suite's
// default per-file concurrency
const { publicKey: primaryPub, privateKey: primaryPriv } = crypto.generateKeyPairSync("ed25519");
fs.writeFileSync(
  keyStateFile,
  JSON.stringify({
    primary_public_key_pem: primaryPub.export({ type: "spki", format: "pem" }).toString(),
    primary_rotated_at: "2026-11-01T00:00:00.000Z",
    secondary_public_key_pem: primaryPub.export({ type: "spki", format: "pem" }).toString(),
    secondary_rotated_at: "2026-11-01T00:00:00.000Z",
  })
);

process.env.AGENT_PORT = "0";
process.env.MISSION_AGENT_TOKEN = TOKEN;
process.env.DCS_SAVED_GAMES_ROOT = savedGamesRoot;
process.env.AGENT_SELF_UPDATE_ROOT = selfUpdateRoot;
process.env.AGENT_KEY_STATE_FILE = keyStateFile;
// without this, a successful commit call would exit this test process
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
  fs.rmSync(keyStateDir, { recursive: true, force: true });
});

// the bearer header every authenticated request below needs
function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// signs a manifest claiming the given body's real sha256 under
// artifact "agent", the shape the agent's /self-update/stage expects
function manifestHeadersFor(body, version = "9.9.9") {
  const signed = {
    version,
    changelog_url: "https://example.test/changelog",
    needs_service_update: false,
    downloads: [{ artifact: "agent", url: "https://example.test/agent.exe", sha256: sha256(body) }],
  };
  const signature = crypto.sign(null, Buffer.from(JSON.stringify(signed)), primaryPriv).toString("hex");
  return { "X-Manifest-Signed": JSON.stringify(signed), "X-Manifest-Signature": signature };
}

test("stage rejects requests with no token", async () => {
  const body = Buffer.from("fake exe bytes");
  const res = await fetch(`${base}/self-update/stage`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body,
  });
  assert.equal(res.status, 401);
});

test("stage rejects a body that doesn't match the signed manifest's own sha256 for the agent artifact", async () => {
  const claimedBody = Buffer.from("the body the manifest claims to describe");
  const actualBody = Buffer.from("a different, tampered body sent instead");
  const res = await fetch(`${base}/self-update/stage`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/octet-stream", ...manifestHeadersFor(claimedBody) }),
    body: actualBody,
  });
  assert.equal(res.status, 400);
});

test("stage rejects a manifest signed with a key other than the trusted primary", async () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const body = Buffer.from("fake exe bytes");
  const signed = {
    version: "1.2.3",
    downloads: [{ artifact: "agent", url: "https://example.test/agent.exe", sha256: sha256(body) }],
  };
  const signature = crypto.sign(null, Buffer.from(JSON.stringify(signed)), privateKey).toString("hex");
  const res = await fetch(`${base}/self-update/stage`, {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/octet-stream",
      "X-Manifest-Signed": JSON.stringify(signed),
      "X-Manifest-Signature": signature,
    }),
    body,
  });
  assert.equal(res.status, 400);
});

test("stage rejects a manifest whose version is not strictly newer than the agent's own, even with a valid signature and sha256", async () => {
  const currentVersion = require("../package.json").version;
  const body = Buffer.from("fake exe bytes");
  const equalRes = await fetch(`${base}/self-update/stage`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/octet-stream", ...manifestHeadersFor(body, currentVersion) }),
    body,
  });
  assert.equal(equalRes.status, 400);

  const lowerRes = await fetch(`${base}/self-update/stage`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/octet-stream", ...manifestHeadersFor(body, "0.0.1") }),
    body,
  });
  assert.equal(lowerRes.status, 400);
});

// order matters, AGENT_SELF_UPDATE_ROOT is read once at module load and
// can't be swapped per test, so this is the one point where nothing's staged
test("commit rejects when nothing has been staged in the idle slot", async () => {
  const res = await fetch(`${base}/self-update/commit`, { method: "POST", headers: authHeaders() });
  assert.equal(res.status, 400);
});

test("stage writes the exe into the idle slot (not the active one)", async () => {
  // nothing active yet, so the idle slot defaults to "b"
  const body = Buffer.from("fresh build bytes");
  const res = await fetch(`${base}/self-update/stage`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/octet-stream", ...manifestHeadersFor(body) }),
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
  // the process would normally exit right after responding, so the
  // response itself is the only thing safe to check here
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.activeSlot, "b");

  const linkTarget = fs.readlinkSync(path.join(selfUpdateRoot, "current"));
  assert.equal(path.basename(linkTarget), "b");
});

test("commit leaves current untouched when building the new junction fails", async (t) => {
  // stage a fresh build into whatever slot is idle now (a, since the
  // previous test flipped current to b)
  const body = Buffer.from("another build's bytes");
  await fetch(`${base}/self-update/stage`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/octet-stream", ...manifestHeadersFor(body) }),
    body,
  });

  const beforeTarget = fs.readlinkSync(path.join(selfUpdateRoot, "current"));
  t.mock.method(fsp, "symlink", () => {
    throw new Error("simulated symlink failure");
  });

  const res = await fetch(`${base}/self-update/commit`, { method: "POST", headers: authHeaders() });
  assert.equal(res.status, 500);

  const afterTarget = fs.readlinkSync(path.join(selfUpdateRoot, "current"));
  assert.equal(afterTarget, beforeTarget, "current must still point at its original slot after a failed symlink attempt");
});

test("commit still flips current once the junction can be built again", async () => {
  const res = await fetch(`${base}/self-update/commit`, { method: "POST", headers: authHeaders() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.activeSlot, "a");

  const linkTarget = fs.readlinkSync(path.join(selfUpdateRoot, "current"));
  assert.equal(path.basename(linkTarget), "a");
});

test("commit rejects requests with no token", async () => {
  const res = await fetch(`${base}/self-update/commit`, { method: "POST" });
  assert.equal(res.status, 401);
});
