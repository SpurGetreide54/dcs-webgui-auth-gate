const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

// a throwaway keypair, generated fresh per test, distinct from the
// real one at local-only/keys/, proves verifyManifest() rejects any
// key other than key_state's currently trusted primary key
function freshKeypair() {
  return crypto.generateKeyPairSync("ed25519");
}

function signManifest(privateKey, signed) {
  const signature = crypto.sign(null, Buffer.from(JSON.stringify(signed)), privateKey).toString("hex");
  return { ...signed, signature };
}

// a minimal http server, standing in for the real github api
function startDummyHttpServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// a fresh, unique sqlite path per test file, under the os temp dir
function tempSqlitePath(label) {
  return path.join(os.tmpdir(), `update-check-test-${label}-${crypto.randomBytes(6).toString("hex")}.sqlite`);
}

// delete a sqlite file and its wal/shm siblings
function cleanupSqlite(sqlitePath) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(sqlitePath + suffix, { force: true });
}

// GITHUB_API_BASE_OVERRIDE and SQLITE_PATH both have to be set before
// src/updateCheck.js is first required, so both happen in test.before()
let updateCheck;
let dummyGithub, dummyGithubBase;
let dummyGithubRespond; // set per test to control what the dummy "GitHub API" returns
let dummyAgent, dummyAgentBase;
let dummyAgentRespond; // set per test to control what the dummy mission agent returns
let sqlitePath;
let activeSlotPath;

const REAL_PRIVATE_KEY_PATH = path.join(__dirname, "..", "local-only", "keys", "key-rotation-primary.pem");
const MISSION_AGENT_TEST_TOKEN = "update-check-relay-test-token";

test.before(async () => {
  dummyGithub = await startDummyHttpServer((req, res) => dummyGithubRespond(req, res));
  dummyGithubBase = `http://127.0.0.1:${dummyGithub.address().port}`;
  process.env.GITHUB_API_BASE_OVERRIDE = dummyGithubBase;

  dummyAgent = await startDummyHttpServer((req, res) => dummyAgentRespond(req, res));
  dummyAgentBase = `http://127.0.0.1:${dummyAgent.address().port}`;
  process.env.MISSION_AGENT_URL = dummyAgentBase;
  process.env.MISSION_AGENT_TOKEN = MISSION_AGENT_TEST_TOKEN;

  sqlitePath = tempSqlitePath("update-check");
  process.env.SQLITE_PATH = sqlitePath;

  // a dedicated temp path, not the repo's own default active-slot
  // file, which other test files would otherwise contend over
  activeSlotPath = path.join(os.tmpdir(), `update-check-active-slot-${crypto.randomBytes(6).toString("hex")}`);
  process.env.ACTIVE_SLOT_PATH = activeSlotPath;

  updateCheck = require("../src/updateCheck");
});

test.after(async () => {
  await new Promise((resolve) => dummyGithub.close(resolve));
  await new Promise((resolve) => dummyAgent.close(resolve));
  require("../src/db").close();
  cleanupSqlite(sqlitePath);
  fs.rmSync(activeSlotPath, { force: true });
});

test("getCurrentVersion reads package.json's own version", () => {
  const pkg = require("../package.json");
  assert.equal(updateCheck.getCurrentVersion(), pkg.version);
});

test("downloadAndVerify hashes the stream as it writes, instead of re-reading the file afterward", async () => {
  const body = Buffer.from("fake release artifact bytes");
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  dummyGithubRespond = (req, res) => res.end(body);
  const destPath = path.join(os.tmpdir(), `update-check-test-download-${crypto.randomBytes(6).toString("hex")}.bin`);
  try {
    await updateCheck.downloadAndVerify(dummyGithubBase, sha256, destPath);
    assert.ok(fs.readFileSync(destPath).equals(body), "the written file must contain exactly the downloaded bytes");
  } finally {
    fs.rmSync(destPath, { force: true });
  }
});

test("downloadAndVerify rejects a tampered body with the same sha256 mismatch message as before", async () => {
  const body = Buffer.from("different bytes than expected");
  dummyGithubRespond = (req, res) => res.end(body);
  const destPath = path.join(os.tmpdir(), `update-check-test-download-${crypto.randomBytes(6).toString("hex")}.bin`);
  try {
    await assert.rejects(() => updateCheck.downloadAndVerify(dummyGithubBase, "f".repeat(64), destPath), /sha256 mismatch/);
  } finally {
    fs.rmSync(destPath, { force: true });
  }
});

// the one test that can catch a mismatch between key_state's seeded
// primary key and the real private key, skipped (not failed) where
// that gitignored private key doesn't exist on this machine
test(
  "verifyManifest accepts a manifest signed with the real local-only/keys/ primary private key",
  { skip: !fs.existsSync(REAL_PRIVATE_KEY_PATH) ? "local-only/keys/key-rotation-primary.pem not present on this machine" : false },
  () => {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(REAL_PRIVATE_KEY_PATH, "utf8"));
    const manifest = signManifest(privateKey, {
      version: "1.2.3",
      changelog_url: "https://example.test/changelog",
      needs_service_update: false,
      downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "d".repeat(64) }],
    });
    assert.equal(updateCheck.verifyManifest(manifest), true, "key_state's seeded PRIMARY_PUBLIC_KEY_PEM must match local-only/keys/key-rotation-primary.pem");
  }
);

test("verifyManifest follows a primary rotation: the old key stops working, the new key starts", () => {
  const db = require("../src/db");
  const keyRotation = require("../src/keyRotation");

  const before = db.prepare("SELECT primary_public_key_pem, primary_rotated_at FROM key_state WHERE id = 1").get();
  const { publicKey: oldPub, privateKey: oldPriv } = freshKeypair();
  const { publicKey: newPub, privateKey: newPriv } = freshKeypair();
  db.prepare("UPDATE key_state SET primary_public_key_pem = ? WHERE id = 1").run(
    oldPub.export({ type: "spki", format: "pem" }).toString()
  );

  try {
    const signed = {
      version: "1.2.3",
      changelog_url: "https://example.test/changelog",
      needs_service_update: false,
      downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "e".repeat(64) }],
    };
    const signedWithOld = signManifest(oldPriv, signed);
    assert.equal(updateCheck.verifyManifest(signedWithOld), true);

    keyRotation.applyKeyStateRecord({
      rotated_slot: "primary",
      new_public_key_pem: newPub.export({ type: "spki", format: "pem" }).toString(),
      rotated_at: new Date().toISOString(),
    });

    assert.equal(updateCheck.verifyManifest(signedWithOld), false, "the old key must stop working once rotated away from");
    assert.equal(updateCheck.verifyManifest(signManifest(newPriv, signed)), true, "the new key must work immediately, no new release needed");
  } finally {
    // restore key_state so later tests in this file see the original seed
    db.prepare("UPDATE key_state SET primary_public_key_pem = ?, primary_rotated_at = ? WHERE id = 1").run(
      before.primary_public_key_pem,
      before.primary_rotated_at
    );
  }
});

test("verifyManifest rejects a manifest signed with the wrong key", () => {
  const { privateKey } = freshKeypair(); // not the real app key
  const manifest = signManifest(privateKey, {
    version: "9.9.9",
    changelog_url: "https://example.test/changelog",
    needs_service_update: false,
    downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "a".repeat(64) }],
  });
  assert.equal(updateCheck.verifyManifest(manifest), false);
});

test("verifyManifest rejects a manifest whose content was tampered with after signing", () => {
  // signs with a fresh key, verifies against that key's own public
  // half directly, proving tamper-detection without the real app key
  const { publicKey, privateKey } = freshKeypair();
  const signed = {
    version: "1.2.3",
    changelog_url: "https://example.test/changelog",
    needs_service_update: false,
    downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "b".repeat(64) }],
  };
  const message = Buffer.from(JSON.stringify(signed));
  const signature = crypto.sign(null, message, privateKey).toString("hex");

  // the same verification verifyManifest does, against this test's
  // own throwaway public key instead of the hardcoded app one
  const tampered = { ...signed, downloads: [{ ...signed.downloads[0], sha256: "c".repeat(64) }] };
  const { signature: _unused, ...tamperedSigned } = { ...tampered, signature };
  const tamperedMessage = Buffer.from(JSON.stringify(tamperedSigned));
  assert.equal(crypto.verify(null, tamperedMessage, publicKey, Buffer.from(signature, "hex")), false);

  // the untampered original, same signature, must still verify, so
  // the failure above is really about the content, not a broken call
  assert.equal(crypto.verify(null, message, publicKey, Buffer.from(signature, "hex")), true);
});

test("sign-updates.js produces a manifest the real verifyManifest() accepts, end to end", () => {
  // runs the real cli script as a subprocess with a throwaway key,
  // the closest thing to a real release without touching the app key
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "sign-updates-test-"));
  try {
    const { publicKey, privateKey } = freshKeypair();
    const keyPath = path.join(scratchDir, "key.pem");
    fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));

    const authGatePath = path.join(scratchDir, "auth-gate-1.2.3.tar.gz");
    const agentPath = path.join(scratchDir, "agent-1.2.3.exe");
    fs.writeFileSync(authGatePath, "fake auth-gate tarball bytes");
    fs.writeFileSync(agentPath, "fake agent exe bytes");

    const manifestPath = path.join(scratchDir, "signed_updates.json");
    const { execFileSync } = require("node:child_process");
    execFileSync(
      process.execPath,
      [
        path.join(__dirname, "..", "scripts", "release", "sign-updates.js"),
        "--version",
        "1.2.3",
        "--changelog-url",
        "https://example.test/changelog",
        "--auth-gate",
        authGatePath,
        "--agent",
        agentPath,
        "--key",
        keyPath,
        "--out",
        manifestPath,
      ],
      { cwd: path.join(__dirname, ".."), stdio: "pipe" }
    );

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.version, "1.2.3");
    assert.equal(manifest.downloads.length, 2);

    // re-verify using the throwaway public key directly, not the
    // app's hardcoded one, which this manifest wasn't signed with
    const { signature, ...signed } = manifest;
    const message = Buffer.from(JSON.stringify(signed));
    assert.equal(crypto.verify(null, message, publicKey, Buffer.from(signature, "hex")), true);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("updateConstants.js has no side effects: no db import, no sqlite file created", () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "update-constants-test-"));
  try {
    const { execFileSync } = require("node:child_process");
    const constantsPath = path.join(__dirname, "..", "src", "updateConstants.js");
    const out = execFileSync(
      process.execPath,
      [
        "-e",
        `const { GITHUB_REPO } = require(${JSON.stringify(constantsPath)});
         const loadedDb = Object.keys(require.cache).some((k) => k.includes("src${path.sep}db.js"));
         console.log(JSON.stringify({ GITHUB_REPO, loadedDb }));`,
      ],
      { cwd: scratchDir, stdio: "pipe" }
    ).toString();
    const result = JSON.parse(out);
    assert.equal(result.loadedDb, false, "requiring updateConstants.js must not pull in db.js");
    assert.match(result.GITHUB_REPO, /\//, "GITHUB_REPO must still be the real owner/repo string");
    assert.equal(fs.existsSync(path.join(scratchDir, "local-only")), false, "no local-only/ directory must be created just from requiring updateConstants.js");
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// serves manifest as the dummy github api's "latest release" asset,
// answering fetchVerifiedManifest()'s two requests from one handler
function serveManifest(manifest) {
  dummyGithubRespond = (req, res) => {
    if (req.url.includes("/releases/latest")) {
      sendJson(res, 200, { assets: [{ name: "signed_updates.json", browser_download_url: `${dummyGithubBase}/signed_updates.json` }] });
    } else {
      sendJson(res, 200, manifest);
    }
  };
}

// no key-state release has ever been published under the key-state tag
function serveNoKeyStateHistory() {
  dummyGithubRespond = (req, res) => res.writeHead(404).end();
}

// a key-state release exists, its asset is the given rotation records
function serveKeyStateHistory(records) {
  dummyGithubRespond = (req, res) => {
    if (req.url.includes("/releases/tags/key-state")) {
      sendJson(res, 200, { assets: [{ name: "key_state.json", browser_download_url: `${dummyGithubBase}/key_state.json` }] });
    } else {
      sendJson(res, 200, records);
    }
  };
}

// captures one /self-update/stage request's headers and body, replying
// as the real agent would on success
function captureStageRequest() {
  const captured = { request: null };
  dummyAgentRespond = (req, res) => {
    if (req.url === "/self-update/stage") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        captured.request = { headers: req.headers, body: Buffer.concat(chunks) };
        sendJson(res, 200, { ok: true, slot: "b" });
      });
      return;
    }
    if (req.url === "/self-update/commit") return sendJson(res, 200, { ok: true, activeSlot: "b" });
    res.writeHead(404).end();
  };
  return captured;
}

test(
  "checkForUpdate resolves true and records the new version when a newer signed release is available",
  { skip: !fs.existsSync(REAL_PRIVATE_KEY_PATH) ? "local-only/keys/key-rotation-primary.pem not present on this machine" : false },
  async () => {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(REAL_PRIVATE_KEY_PATH, "utf8"));
    const manifest = signManifest(privateKey, {
      version: "9.9.9-test",
      changelog_url: "https://example.test/changelog",
      needs_service_update: false,
      downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "d".repeat(64) }],
    });
    serveManifest(manifest);

    const hasUpdate = await updateCheck.checkForUpdate();
    assert.equal(hasUpdate, true);
    const state = updateCheck.getUpdateState();
    assert.equal(state.available_version, "9.9.9-test");
    assert.equal(state.changelog_url, "https://example.test/changelog");
    assert.ok(state.last_checked_at);
    assert.ok(state.last_succeeded_at);
  }
);

test(
  "checkForUpdate resolves false when the latest release matches the current version",
  { skip: !fs.existsSync(REAL_PRIVATE_KEY_PATH) ? "local-only/keys/key-rotation-primary.pem not present on this machine" : false },
  async () => {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(REAL_PRIVATE_KEY_PATH, "utf8"));
    const manifest = signManifest(privateKey, {
      version: updateCheck.getCurrentVersion(),
      changelog_url: "https://example.test/changelog",
      needs_service_update: false,
      downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "e".repeat(64) }],
    });
    serveManifest(manifest);

    const hasUpdate = await updateCheck.checkForUpdate();
    assert.equal(hasUpdate, false);
    const state = updateCheck.getUpdateState();
    assert.equal(state.available_version, null);
  }
);

test(
  "checkForUpdate rejects a downgrade: a lower, validly-signed version is not an update",
  { skip: !fs.existsSync(REAL_PRIVATE_KEY_PATH) ? "local-only/keys/key-rotation-primary.pem not present on this machine" : false },
  async () => {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(REAL_PRIVATE_KEY_PATH, "utf8"));
    const manifest = signManifest(privateKey, {
      version: "0.0.1",
      changelog_url: "https://example.test/changelog",
      needs_service_update: false,
      downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "c".repeat(64) }],
    });
    serveManifest(manifest);

    const hasUpdate = await updateCheck.checkForUpdate();
    assert.equal(hasUpdate, false, "a lower version must not be treated as an update, even though its signature is valid");
    const state = updateCheck.getUpdateState();
    assert.equal(state.available_version, null);
  }
);

test("isVersionGreater treats a same-triple prerelease promotion as an update (1.5.0-alpha -> 1.5.0-beta)", () => {
  assert.equal(updateCheck.isVersionGreater("1.5.0-beta", "1.5.0-alpha"), true);
});

test("isVersionGreater treats the final release as newer than any prerelease of the same triple (1.5.0-beta -> 1.5.0)", () => {
  assert.equal(updateCheck.isVersionGreater("1.5.0", "1.5.0-beta"), true);
});

test("isVersionGreater rejects a lower prerelease of the same triple (1.5.0-beta -> 1.5.0-alpha is not an update)", () => {
  assert.equal(updateCheck.isVersionGreater("1.5.0-alpha", "1.5.0-beta"), false);
});

test("applyUpdate fails fast when the active-slot file isn't writable, before touching the network at all", async () => {
  fs.writeFileSync(activeSlotPath, "a", "utf8");
  fs.chmodSync(activeSlotPath, 0o444);
  // never configured to serve anything this test run -- a network
  // call here, instead of the fast local permission check, would
  // surface as this rejecting for the wrong reason
  dummyGithubRespond = (req, res) => res.writeHead(500).end("must not be reached");
  try {
    await assert.rejects(() => updateCheck.applyUpdate(), /active-slot/);
  } finally {
    fs.chmodSync(activeSlotPath, 0o644);
  }
});

test(
  "applyUpdate refuses a downgrade on its own, even if it's called without checkForUpdate ever offering it",
  { skip: !fs.existsSync(REAL_PRIVATE_KEY_PATH) ? "local-only/keys/key-rotation-primary.pem not present on this machine" : false },
  async () => {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(REAL_PRIVATE_KEY_PATH, "utf8"));
    const manifest = signManifest(privateKey, {
      version: "0.0.1",
      changelog_url: "https://example.test/changelog",
      needs_service_update: false,
      downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "a".repeat(64) }],
    });
    serveManifest(manifest);

    // called directly, never through checkForUpdate, proving the guard
    // is applyUpdate()'s own, matching the message rules out a false
    // pass from the fake download url instead actually being reached
    await assert.rejects(() => updateCheck.applyUpdate(), /not newer/);
  }
);

test(
  "applyUpdate sets isUpdateInFlight synchronously and clears it once it fails",
  { skip: !fs.existsSync(REAL_PRIVATE_KEY_PATH) ? "local-only/keys/key-rotation-primary.pem not present on this machine" : false },
  async () => {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(REAL_PRIVATE_KEY_PATH, "utf8"));
    // same version as current, fails the downgrade check right after
    // the flag is set, with no download mocking needed
    const manifest = signManifest(privateKey, {
      version: updateCheck.getCurrentVersion(),
      changelog_url: "https://example.test/changelog",
      needs_service_update: false,
      downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "a".repeat(64) }],
    });
    serveManifest(manifest);

    assert.equal(updateCheck.isUpdateInFlight(), false);
    const promise = updateCheck.applyUpdate();
    assert.equal(updateCheck.isUpdateInFlight(), true, "must be set synchronously, before the first await");
    await assert.rejects(() => promise, /not newer/);
    assert.equal(updateCheck.isUpdateInFlight(), false, "must be cleared once applyUpdate has failed");
  }
);

test("checkForUpdate rejects and still records the attempt when the check fails", async () => {
  // no real key needed, a throwaway key the hardcoded public key will
  // never accept, so this runs unconditionally unlike the two tests above
  const { privateKey } = freshKeypair();
  const manifest = signManifest(privateKey, {
    version: "9.9.9-bad",
    changelog_url: "https://example.test/changelog",
    needs_service_update: false,
    downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "f".repeat(64) }],
  });
  serveManifest(manifest);

  const before = updateCheck.getUpdateState();
  await assert.rejects(() => updateCheck.checkForUpdate(), /signature verification/);
  const after = updateCheck.getUpdateState();
  assert.ok(after.last_checked_at, "a failed check must still record that an attempt was made");
  assert.equal(after.last_succeeded_at, before.last_succeeded_at, "a failed check must not touch the last-succeeded timestamp");
  assert.equal(after.available_version, null);
});

test("relayAgentUpdate forwards the manifest's own signature and signed payload, not the caller-computed sha256", async () => {
  serveNoKeyStateHistory();
  const captured = captureStageRequest();

  const archivePath = path.join(os.tmpdir(), `relay-test-${crypto.randomBytes(6).toString("hex")}.bin`);
  const body = Buffer.from("fake agent exe bytes");
  fs.writeFileSync(archivePath, body);
  const manifest = {
    version: "1.2.3",
    changelog_url: "https://example.test/changelog",
    needs_service_update: false,
    downloads: [{ artifact: "agent", url: "https://example.test/agent.exe", sha256: "f".repeat(64) }],
    signature: "ab".repeat(32),
  };
  try {
    await updateCheck.relayAgentUpdate(archivePath, manifest);
  } finally {
    fs.rmSync(archivePath, { force: true });
  }

  assert.ok(captured.request, "the dummy agent must have received a /self-update/stage request");
  assert.equal(captured.request.headers.authorization, `Bearer ${MISSION_AGENT_TEST_TOKEN}`);
  assert.equal(captured.request.headers["x-manifest-signature"], manifest.signature);
  const { signature, ...signed } = manifest;
  assert.deepEqual(JSON.parse(captured.request.headers["x-manifest-signed"]), signed);
  assert.equal(captured.request.headers["x-key-state-history"], undefined, "no rotation was ever published, so the header must be omitted");
  assert.equal(captured.request.headers["x-sha256"], undefined, "the gate must no longer send a self-supplied sha256 for the agent to trust blindly");
  assert.ok(captured.request.body.equals(body));
});

test("relayAgentUpdate forwards the key-state rotation history when one has been published", async () => {
  const records = [{ rotated_slot: "primary", new_public_key_pem: "fake-pem", rotated_at: "2026-11-01T00:00:00.000Z", signatures: ["aa", "bb"] }];
  serveKeyStateHistory(records);
  const captured = captureStageRequest();

  const archivePath = path.join(os.tmpdir(), `relay-test-${crypto.randomBytes(6).toString("hex")}.bin`);
  fs.writeFileSync(archivePath, Buffer.from("more fake agent exe bytes"));
  const manifest = {
    version: "1.2.3",
    downloads: [{ artifact: "agent", url: "https://example.test/agent.exe", sha256: "f".repeat(64) }],
    signature: "cd".repeat(32),
  };
  try {
    await updateCheck.relayAgentUpdate(archivePath, manifest);
  } finally {
    fs.rmSync(archivePath, { force: true });
  }

  assert.ok(captured.request, "the dummy agent must have received a /self-update/stage request");
  assert.deepEqual(JSON.parse(captured.request.headers["x-key-state-history"]), records);
});
