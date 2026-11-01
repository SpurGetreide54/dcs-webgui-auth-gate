const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

function freshKeypair() {
  return crypto.generateKeyPairSync("ed25519");
}

function pem(key, isPrivate) {
  return isPrivate ? key.export({ type: "pkcs8", format: "pem" }).toString() : key.export({ type: "spki", format: "pem" }).toString();
}

function keyStateMessage({ rotated_slot, new_public_key_pem, rotated_at }) {
  return Buffer.from(JSON.stringify({ rotated_slot, new_public_key_pem, rotated_at }));
}

function signRecord(record, selfPrivateKey, vouchPrivateKey) {
  const message = keyStateMessage(record);
  return { ...record, signatures: [crypto.sign(null, message, selfPrivateKey).toString("hex"), crypto.sign(null, message, vouchPrivateKey).toString("hex")] };
}

function startDummyHttpServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function tempSqlitePath(label) {
  return path.join(os.tmpdir(), `key-rotation-test-${label}-${crypto.randomBytes(6).toString("hex")}.sqlite`);
}

function cleanupSqlite(sqlitePath) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(sqlitePath + suffix, { force: true });
}

let keyRotation, db;
let dummyGithub, dummyGithubBase;
let dummyGithubRespond;
let sqlitePath;

const REAL_PRIMARY_KEY_PATH = path.join(__dirname, "..", "local-only", "keys", "key-rotation-primary.pub.pem");
const REAL_SECONDARY_KEY_PATH = path.join(__dirname, "..", "local-only", "keys", "key-rotation-secondary.pub.pem");

test.before(async () => {
  dummyGithub = await startDummyHttpServer((req, res) => dummyGithubRespond(req, res));
  dummyGithubBase = `http://127.0.0.1:${dummyGithub.address().port}`;
  process.env.GITHUB_API_BASE_OVERRIDE = dummyGithubBase;

  sqlitePath = tempSqlitePath("main");
  process.env.SQLITE_PATH = sqlitePath;

  db = require("../src/db");
  keyRotation = require("../src/keyRotation");
});

test.after(async () => {
  await new Promise((resolve) => dummyGithub.close(resolve));
  db.close();
  cleanupSqlite(sqlitePath);
});

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function serveKeyStateRecord(record) {
  dummyGithubRespond = (req, res) => {
    if (req.url.includes(`/releases/tags/${keyRotation.KEY_STATE_TAG}`)) {
      sendJson(res, 200, { assets: [{ name: "key_state.json", browser_download_url: `${dummyGithubBase}/key_state.json` }] });
    } else {
      sendJson(res, 200, record);
    }
  };
}

function serveNoReleaseYet() {
  dummyGithubRespond = (req, res) => res.writeHead(404).end();
}

test("getKeyState starts seeded with the two hardcoded placeholder/real public keys", () => {
  const state = keyRotation.getKeyState();
  assert.equal(state.id, 1);
  assert.ok(state.primary_public_key_pem.includes("BEGIN PUBLIC KEY"));
  assert.ok(state.secondary_public_key_pem.includes("BEGIN PUBLIC KEY"));
  assert.ok(state.primary_rotated_at);
  assert.ok(state.secondary_rotated_at);
  assert.equal(state.primary_next_target_rotation_at, null);
  assert.equal(state.secondary_next_target_rotation_at, null);
});

test(
  "the hardcoded PRIMARY_PUBLIC_KEY_PEM/SECONDARY_PUBLIC_KEY_PEM must be real ed25519 keys, not left as placeholders",
  () => {
    const { PRIMARY_PUBLIC_KEY_PEM, SECONDARY_PUBLIC_KEY_PEM } = require("../src/keyRotationConstants");
    const primary = crypto.createPublicKey(PRIMARY_PUBLIC_KEY_PEM);
    const secondary = crypto.createPublicKey(SECONDARY_PUBLIC_KEY_PEM);
    assert.equal(primary.asymmetricKeyType, "ed25519");
    assert.equal(secondary.asymmetricKeyType, "ed25519");
    assert.notEqual(pem(primary), pem(secondary), "primary and secondary must not be the same key");
  }
);

test("verifyKeyState accepts a secondary rotation vouched for by the current primary key", () => {
  const { publicKey: newSecondaryPub, privateKey: newSecondaryPriv } = freshKeypair();
  const { privateKey: currentPrimaryPriv, publicKey: currentPrimaryPub } = freshKeypair();
  const currentState = {
    primary_public_key_pem: pem(currentPrimaryPub),
    primary_rotated_at: "2026-01-01T00:00:00.000Z",
    secondary_public_key_pem: pem(freshKeypair().publicKey),
    secondary_rotated_at: "2026-01-01T00:00:00.000Z",
  };
  const record = signRecord(
    { rotated_slot: "secondary", new_public_key_pem: pem(newSecondaryPub), rotated_at: "2026-02-01T00:00:00.000Z" },
    newSecondaryPriv,
    currentPrimaryPriv
  );
  assert.equal(keyRotation.verifyKeyState(record, currentState), true);
});

test("verifyKeyState rejects a self-signature from the wrong key (not the one new_public_key_pem names)", () => {
  const { publicKey: newSecondaryPub } = freshKeypair();
  const { privateKey: wrongPriv } = freshKeypair(); // does not match newSecondaryPub
  const { privateKey: currentPrimaryPriv, publicKey: currentPrimaryPub } = freshKeypair();
  const currentState = {
    primary_public_key_pem: pem(currentPrimaryPub),
    primary_rotated_at: "2026-01-01T00:00:00.000Z",
    secondary_public_key_pem: pem(freshKeypair().publicKey),
    secondary_rotated_at: "2026-01-01T00:00:00.000Z",
  };
  const record = signRecord(
    { rotated_slot: "secondary", new_public_key_pem: pem(newSecondaryPub), rotated_at: "2026-02-01T00:00:00.000Z" },
    wrongPriv,
    currentPrimaryPriv
  );
  assert.equal(keyRotation.verifyKeyState(record, currentState), false);
});

test("verifyKeyState rejects a vouch signature not from the surviving slot's trusted key", () => {
  const { publicKey: newSecondaryPub, privateKey: newSecondaryPriv } = freshKeypair();
  const { privateKey: impostorPriv } = freshKeypair(); // not the trusted primary
  const currentState = {
    primary_public_key_pem: pem(freshKeypair().publicKey),
    primary_rotated_at: "2026-01-01T00:00:00.000Z",
    secondary_public_key_pem: pem(freshKeypair().publicKey),
    secondary_rotated_at: "2026-01-01T00:00:00.000Z",
  };
  const record = signRecord(
    { rotated_slot: "secondary", new_public_key_pem: pem(newSecondaryPub), rotated_at: "2026-02-01T00:00:00.000Z" },
    newSecondaryPriv,
    impostorPriv
  );
  assert.equal(keyRotation.verifyKeyState(record, currentState), false);
});

test("verifyKeyState rejects a replayed record (rotated_at not newer than what's already trusted)", () => {
  const { publicKey: newSecondaryPub, privateKey: newSecondaryPriv } = freshKeypair();
  const { privateKey: currentPrimaryPriv, publicKey: currentPrimaryPub } = freshKeypair();
  const currentState = {
    primary_public_key_pem: pem(currentPrimaryPub),
    primary_rotated_at: "2026-01-01T00:00:00.000Z",
    secondary_public_key_pem: pem(freshKeypair().publicKey),
    secondary_rotated_at: "2026-03-01T00:00:00.000Z", // already newer than the record below
  };
  const record = signRecord(
    { rotated_slot: "secondary", new_public_key_pem: pem(newSecondaryPub), rotated_at: "2026-02-01T00:00:00.000Z" },
    newSecondaryPriv,
    currentPrimaryPriv
  );
  assert.equal(keyRotation.verifyKeyState(record, currentState), false);
});

test("verifyKeyState rejects garbage input instead of throwing", () => {
  const currentState = {
    primary_public_key_pem: pem(freshKeypair().publicKey),
    primary_rotated_at: "2026-01-01T00:00:00.000Z",
    secondary_public_key_pem: pem(freshKeypair().publicKey),
    secondary_rotated_at: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(keyRotation.verifyKeyState({ rotated_slot: "primary", new_public_key_pem: "not a pem", rotated_at: "x", signatures: ["a", "b"] }, currentState), false);
  assert.equal(keyRotation.verifyKeyState({ rotated_slot: "tertiary" }, currentState), false);
  assert.equal(keyRotation.verifyKeyState({ rotated_slot: "primary", signatures: ["only-one"] }, currentState), false);
});

test("computeNextTargetRotationAt lands within the documented ~30 day +/- 3 day jitter window", () => {
  const rotatedAt = "2026-01-01T00:00:00.000Z";
  const base = new Date(rotatedAt).getTime();
  for (let i = 0; i < 20; i++) {
    const next = new Date(keyRotation.computeNextTargetRotationAt(rotatedAt)).getTime();
    const deltaDays = (next - base) / (24 * 60 * 60 * 1000);
    assert.ok(deltaDays >= 27 && deltaDays <= 33, `expected 27-33 days out, got ${deltaDays}`);
  }
});

test("checkKeyState does nothing (but still records the attempt) when no key-state release has ever been published", async () => {
  serveNoReleaseYet();
  const before = keyRotation.getKeyState();
  await keyRotation.checkKeyState();
  const after = keyRotation.getKeyState();
  assert.ok(after.last_checked_at);
  assert.equal(after.primary_public_key_pem, before.primary_public_key_pem);
  assert.equal(after.secondary_public_key_pem, before.secondary_public_key_pem);
});

test("checkKeyState applies a verified secondary rotation and sets a jittered next_target_rotation_at", async () => {
  // this test needs to vouch with the CURRENT trusted primary key, which
  // this module seeded from PRIMARY_PUBLIC_KEY_PEM -- no matching private
  // key is available in this process, so it signs with a throwaway key and
  // first overwrites the trusted primary to match, proving checkKeyState's
  // own plumbing without needing the real seeded private key
  const { publicKey: primaryPub, privateKey: primaryPriv } = freshKeypair();
  db.prepare("UPDATE key_state SET primary_public_key_pem = ? WHERE id = 1").run(pem(primaryPub));

  const { publicKey: newSecondaryPub, privateKey: newSecondaryPriv } = freshKeypair();
  const record = signRecord(
    { rotated_slot: "secondary", new_public_key_pem: pem(newSecondaryPub), rotated_at: new Date(Date.now() + 1000).toISOString() },
    newSecondaryPriv,
    primaryPriv
  );
  serveKeyStateRecord(record);

  await keyRotation.checkKeyState();
  const after = keyRotation.getKeyState();
  assert.equal(after.secondary_public_key_pem, pem(newSecondaryPub));
  assert.equal(after.secondary_rotated_at, record.rotated_at);
  assert.ok(after.secondary_next_target_rotation_at);
  assert.ok(new Date(after.secondary_next_target_rotation_at).getTime() > new Date(record.rotated_at).getTime());
  // the primary slot this test didn't touch must be untouched
  assert.equal(after.primary_public_key_pem, pem(primaryPub));
});

test("checkKeyState ignores (does not apply) a record that fails verification, but still records the attempt", async () => {
  const before = keyRotation.getKeyState();
  const { publicKey: newSecondaryPub, privateKey: newSecondaryPriv } = freshKeypair();
  const { privateKey: impostorPriv } = freshKeypair();
  const record = signRecord(
    { rotated_slot: "secondary", new_public_key_pem: pem(newSecondaryPub), rotated_at: new Date(Date.now() + 2000).toISOString() },
    newSecondaryPriv,
    impostorPriv // not the trusted primary
  );
  serveKeyStateRecord(record);

  await keyRotation.checkKeyState();
  const after = keyRotation.getKeyState();
  assert.ok(after.last_checked_at);
  assert.equal(after.secondary_public_key_pem, before.secondary_public_key_pem, "an unverified record must never be applied");
});

test("checkKeyState still records the attempt when the fetch itself fails", async () => {
  dummyGithubRespond = (req, res) => res.writeHead(500).end("boom");
  await keyRotation.checkKeyState();
  const after = keyRotation.getKeyState();
  assert.ok(after.last_checked_at);
});

test(
  "rotate-key.js produces a record the real verifyKeyState() accepts, end to end (secondary rotation)",
  {
    skip: !fs.existsSync(path.join(__dirname, "..", "local-only", "keys", "key-rotation-primary.pem"))
      ? "local-only/keys/key-rotation-primary.pem not present on this machine"
      : false,
  },
  () => {
    const { execFileSync } = require("node:child_process");
    const keysDir = path.join(__dirname, "..", "local-only", "keys");
    const releaseDir = path.join(__dirname, "..", "local-only", "release");
    const secondaryPath = path.join(keysDir, "key-rotation-secondary.pem");
    const secondaryPubPath = path.join(keysDir, "key-rotation-secondary.pub.pem");
    const backupSecondary = fs.existsSync(secondaryPath) ? fs.readFileSync(secondaryPath) : null;
    const backupSecondaryPub = fs.existsSync(secondaryPubPath) ? fs.readFileSync(secondaryPubPath) : null;
    try {
      execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "release", "rotate-key.js"), "secondary"], {
        cwd: path.join(__dirname, ".."),
        stdio: "pipe",
      });
      const record = JSON.parse(fs.readFileSync(path.join(releaseDir, "key_state.json"), "utf8"));
      const { PRIMARY_PUBLIC_KEY_PEM } = require("../src/keyRotationConstants");
      // a fully independent currentState, not the shared db row other
      // tests in this file mutate, including with future-dated
      // rotated_at values that could otherwise outrun this record's own
      const currentState = { primary_public_key_pem: PRIMARY_PUBLIC_KEY_PEM, secondary_rotated_at: "2020-01-01T00:00:00.000Z" };
      assert.equal(
        keyRotation.verifyKeyState(record, currentState),
        true,
        "a record produced by rotate-key.js secondary must verify against the real hardcoded primary key"
      );
    } finally {
      // restore whatever secondary key material existed before this test ran
      if (backupSecondary) fs.writeFileSync(secondaryPath, backupSecondary);
      if (backupSecondaryPub) fs.writeFileSync(secondaryPubPath, backupSecondaryPub);
      fs.rmSync(path.join(releaseDir, "key_state.json"), { force: true });
    }
  }
);
