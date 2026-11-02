const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const TOKEN = "agent-key-rotation-test-token";
const savedGamesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-key-rotation-saved-games-"));
const selfUpdateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-key-rotation-self-update-"));
const keyStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-key-rotation-key-state-"));
const keyStateFile = path.join(keyStateDir, "agent-key-state.json");

// throwaway keypairs, pre-seeded into AGENT_KEY_STATE_FILE below so the
// agent trusts them instead of the real baked-in constants -- the real
// local-only/keys/ material would also work, but it's shared, mutable
// state other test files rotate for real, racy under this suite's
// default per-file concurrency
const { publicKey: primaryPub, privateKey: primaryPriv } = crypto.generateKeyPairSync("ed25519");
const { publicKey: secondaryPub, privateKey: secondaryPriv } = crypto.generateKeyPairSync("ed25519");
fs.writeFileSync(
  keyStateFile,
  JSON.stringify({
    primary_public_key_pem: primaryPub.export({ type: "spki", format: "pem" }).toString(),
    primary_rotated_at: "2026-11-01T00:00:00.000Z",
    secondary_public_key_pem: secondaryPub.export({ type: "spki", format: "pem" }).toString(),
    secondary_rotated_at: "2026-11-01T00:00:00.000Z",
  })
);

process.env.AGENT_PORT = "0";
process.env.MISSION_AGENT_TOKEN = TOKEN;
process.env.DCS_SAVED_GAMES_ROOT = savedGamesRoot;
process.env.AGENT_SELF_UPDATE_ROOT = selfUpdateRoot;
process.env.AGENT_KEY_STATE_FILE = keyStateFile;
process.env.AGENT_SELF_UPDATE_SKIP_EXIT = "1";

const app = require("../src/agent");
const { keyStateMessage } = require("../src/keyRotationConstants");

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

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function signRecord(record, selfPrivateKey, vouchPrivateKey) {
  const message = keyStateMessage(record);
  return {
    ...record,
    signatures: [crypto.sign(null, message, selfPrivateKey).toString("hex"), crypto.sign(null, message, vouchPrivateKey).toString("hex")],
  };
}

test("a rotation record relayed through X-Key-State-History updates the agent's persisted trust file, and a subsequent manifest signed by the new key verifies", async () => {
  const { publicKey: newPrimaryPub, privateKey: newPrimaryPriv } = crypto.generateKeyPairSync("ed25519");

  // vouched by the surviving secondary slot, exactly as real rotation
  // records are vouched by rotate-key.js/sign-key-state-with-secondary.js
  const record = signRecord(
    {
      rotated_slot: "primary",
      new_public_key_pem: newPrimaryPub.export({ type: "spki", format: "pem" }).toString(),
      rotated_at: "2026-12-01T00:00:00.000Z",
    },
    newPrimaryPriv,
    secondaryPriv
  );

  const body = Buffer.from("build staged after a primary rotation");
  const signed = {
    version: "1.2.3",
    downloads: [{ artifact: "agent", url: "https://example.test/agent.exe", sha256: sha256(body) }],
  };
  const signature = crypto.sign(null, Buffer.from(JSON.stringify(signed)), newPrimaryPriv).toString("hex");

  const res = await fetch(`${base}/self-update/stage`, {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/octet-stream",
      "X-Key-State-History": JSON.stringify([record]),
      "X-Manifest-Signed": JSON.stringify(signed),
      "X-Manifest-Signature": signature,
    }),
    body,
  });
  assert.equal(res.status, 200, await res.text().catch(() => ""));

  const persisted = JSON.parse(fs.readFileSync(keyStateFile, "utf8"));
  assert.equal(persisted.primary_public_key_pem, record.new_public_key_pem);
  assert.equal(persisted.primary_rotated_at, record.rotated_at);
});

test("a manifest signed with the now-superseded old primary key is rejected after a rotation has been applied", async () => {
  const body = Buffer.from("a build signed with a key that's no longer trusted");
  const signed = {
    version: "1.2.4",
    downloads: [{ artifact: "agent", url: "https://example.test/agent.exe", sha256: sha256(body) }],
  };
  // signed with the ORIGINAL primary key, superseded by the previous test
  const signature = crypto.sign(null, Buffer.from(JSON.stringify(signed)), primaryPriv).toString("hex");

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
